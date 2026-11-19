import type { Command, McpPromptArgSpec } from '@shared/commands'
import { mcpPromptTurn, type InvokedTurn } from '@shared/promptInvocation'
import type { McpPromptInfo } from '../mcp/client'

/**
 * MCP prompts as slash commands.
 *
 * An MCP server can expose prompt templates (`prompts/list`), and until now only the
 * model could reach them, through `mcp_list_prompts` / `mcp_get_prompt`. Each connected
 * server's prompts are now also offered to the user as `/mcp__<server>__<prompt>`, the
 * same `mcp__<server>__` spelling the server's tools have. Running one fetches the prompt
 * with the user's arguments and sends it as an invoked turn (the chip names the command,
 * never the server's text as if the user wrote it). The turn carries a taint source, so
 * the chat's later memory writes and session launches still ask, as they do after any
 * MCP call.
 */

/** Most prompt commands offered at once, across every server. */
const MAX_PROMPT_COMMANDS = 200
/** Most arguments read from one prompt's declaration. */
const MAX_PROMPT_ARGS = 20
const MAX_DESCRIPTION = 80
const MAX_ARG_TEXT = 4000

/** One line of server-written text, made safe for a menu row. */
function oneLine(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  const v = value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]+/g, ' ').replace(/\s+/g, ' ').trim()
  return v.length > max ? `${v.slice(0, max - 1)}…` : v
}

/**
 * The command name for a server's prompt, or null when nothing usable is left. A
 * server names its prompts as it likes, so anything outside `[A-Za-z0-9_-]` becomes
 * `_`, and edge underscores are dropped so `mcp__a___x` can't read as server `a_`.
 */
export function mcpPromptCommandName(server: string, prompt: string): string | null {
  if (!/^[\w-]+$/.test(server) || server.includes('__')) return null
  const p = prompt
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64)
  return p ? `mcp__${server}__${p}` : null
}

/** Whether a composer line runs an MCP prompt's command (`/mcp__<server>__<prompt> ...`). */
export function isMcpPromptLine(line: string): boolean {
  return /^\/mcp__[\w-]+__\S/.test(line)
}

/** The argument hint shown beside a prompt command: `<topic> [tone]`. */
function argsHint(args: McpPromptArgSpec[]): string | undefined {
  if (!args.length) return undefined
  return args.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(' ')
}

/** The slash commands for the given servers' prompts. A name two prompts map to goes to the first. */
export function mcpPromptCommands(sources: { server: string; prompts: McpPromptInfo[] }[]): Command[] {
  const out: Command[] = []
  const taken = new Set<string>()
  for (const { server, prompts } of sources) {
    for (const p of prompts) {
      if (out.length >= MAX_PROMPT_COMMANDS) return out
      const name = mcpPromptCommandName(server, p.name)
      if (!name || taken.has(name.toLowerCase())) continue
      taken.add(name.toLowerCase())
      const args: McpPromptArgSpec[] = []
      for (const a of p.arguments ?? []) {
        if (args.length >= MAX_PROMPT_ARGS) break
        // An argument is named back to the server as declared, and typed as `name=value`.
        if (typeof a.name !== 'string' || !/^[\w.-]{1,64}$/.test(a.name) || args.some((x) => x.name === a.name)) continue
        const description = oneLine(a.description, MAX_DESCRIPTION)
        args.push({ name: a.name, ...(description ? { description } : {}), ...(a.required ? { required: true } : {}) })
      }
      const hint = argsHint(args)
      out.push({
        name,
        description: oneLine(p.description, MAX_DESCRIPTION) || `${oneLine(p.name, MAX_DESCRIPTION)} prompt from ${server}`,
        ...(hint ? { args: hint } : {}),
        mcpPrompt: { server, prompt: p.name, arguments: args }
      })
    }
  }
  return out
}

/** One typed word: as written with its quotes taken off, and its `name=` split off when it has one. */
type Word = { text: string; name?: string; value?: string }

/**
 * Split what follows the command into words as typed, a "double" or 'single' quoted
 * stretch keeping its spaces (`tone="very formal"` is one word). A quote opens only at
 * the start of a word or right after `name=`, and closes at the same quote followed by
 * a space or the end, so an apostrophe inside a word (`doesn't`) is just a letter. An
 * unclosed quote runs to the end.
 */
function words(text: string): Word[] {
  const out: Word[] = []
  let i = 0
  while (i < text.length) {
    if (/\s/.test(text[i])) {
      i++
      continue
    }
    let word = ''
    let startsQuoted = false
    while (i < text.length && !/\s/.test(text[i])) {
      const c = text[i]
      if ((c === '"' || c === "'") && (word === '' || /^[\w.-]+=$/.test(word))) {
        const close = new RegExp(`${c}(?=\\s|$)`).exec(text.slice(i + 1))
        const end = close ? i + 1 + close.index : text.length
        if (word === '') startsQuoted = true
        word += text.slice(i + 1, end)
        i = end + 1
        continue
      }
      word += c
      i++
    }
    // A word that opened with a quote is all value, even when it reads like `x=1`.
    const eq = startsQuoted ? null : /^([\w.-]+)=([\s\S]*)$/.exec(word)
    out.push(eq ? { text: word, name: eq[1], value: eq[2] } : { text: word })
  }
  return out
}

/**
 * Map what the user typed after `/mcp__<server>__<prompt>` onto the prompt's declared
 * arguments. `name=value` sets one by name (quote a value with spaces:
 * `tone="very formal"`); other words fill the declared arguments in order, and the last
 * one takes any words left over, so `/mcp__docs__summarize the release notes` gives a
 * prompt with one argument the whole phrase. A missing required argument, a name the
 * prompt doesn't declare, or text for a prompt that takes none is an error naming the
 * usage.
 */
export function parseMcpPromptArgs(
  text: string,
  spec: McpPromptArgSpec[],
  usage: string
): { ok: true; values: Record<string, string> } | { ok: false; error: string } {
  const values: Record<string, string> = {}
  const positional: string[] = []
  for (const w of words(text.trim())) {
    // `name=value` only for a declared name: `x=1` in free text is a positional word.
    const named = w.name !== undefined ? spec.find((a) => a.name === w.name) : undefined
    if (named) values[named.name] = w.value ?? ''
    else positional.push(w.text)
  }
  if (positional.length) {
    if (!spec.length) return { ok: false, error: `${usage} takes no arguments.` }
    const open = spec.filter((a) => values[a.name] === undefined)
    if (!open.length) return { ok: false, error: `Every argument is already set by name. Usage: ${usage}` }
    positional.forEach((w, i) => {
      const slot = open[Math.min(i, open.length - 1)]
      values[slot.name] = values[slot.name] === undefined ? w : `${values[slot.name]} ${w}`
    })
  }
  for (const [k, v] of Object.entries(values)) {
    if (v.length > MAX_ARG_TEXT) return { ok: false, error: `The value for ${k} is too long (at most ${MAX_ARG_TEXT} characters).` }
  }
  const missing = spec.filter((a) => a.required && !values[a.name]?.trim())
  if (missing.length) {
    return { ok: false, error: `Missing ${missing.map((a) => a.name).join(', ')}. Usage: ${usage}` }
  }
  return { ok: true, values }
}

/** The usage line for a prompt command: `/mcp__docs__summarize <topic> [tone]`. */
export function mcpPromptUsage(cmd: Command): string {
  return `/${cmd.name}${cmd.args ? ` ${cmd.args}` : ''}`
}

/** Fetch a server's prompt (the manager's, or a test's). */
export type McpPromptFetch = (server: string, prompt: string, args: Record<string, string>) => Promise<string>

export type McpPromptRunResult = { ok: true; turn: InvokedTurn; taintSource: string } | { ok: false; error: string }

/**
 * Run an MCP prompt command: read the arguments, fetch the prompt, and build the
 * invoked turn. `taintSource` goes on the user message (see ChatMessage.taintSource):
 * the text is the server's, not the user's.
 */
export async function prepareMcpPromptRun(
  cmd: Command,
  args: string,
  typed: string,
  fetch: McpPromptFetch
): Promise<McpPromptRunResult> {
  const ref = cmd.mcpPrompt
  if (!ref) return { ok: false, error: `/${cmd.name} is not an MCP prompt.` }
  const parsed = parseMcpPromptArgs(args, ref.arguments, mcpPromptUsage(cmd))
  if (!parsed.ok) return parsed
  let text: string
  try {
    text = (await fetch(ref.server, ref.prompt, parsed.values)).trim()
  } catch (e) {
    return { ok: false, error: `/${cmd.name} failed: ${oneLine((e as Error).message, 300)}` }
  }
  // The clients write a prompt with no messages as this placeholder.
  if (!text || text === '[no content]') return { ok: false, error: `/${cmd.name}: the server returned an empty prompt.` }
  return { ok: true, turn: mcpPromptTurn(cmd, text, typed), taintSource: cmd.name }
}
