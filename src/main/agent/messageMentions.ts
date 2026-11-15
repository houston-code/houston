import { lineRangeLabel, splitLineRange, type LineRange } from '@shared/commandContext'
import { mentionTurn, type InvokedTurn } from '@shared/promptInvocation'
import { readContextFile, resolveContextFile, type ContextConsent } from './commandContext'

/**
 * The `@` mentions in a message that Houston fills in before sending it.
 *
 * A plain `@path` stays a reference the model reads itself, as it always has. Three
 * richer forms are filled in when the message is sent from the terminal's prompt:
 *
 *  - `@path#20-45` (or `#20`): those lines of the file, under a header naming the
 *    range. The file is read the way a command template's `@file` is (see
 *    commandContext.ts): inside the workspace roots through symlinks, capped, a
 *    binary file refused, and a credential file only after asking.
 *  - `@server:uri`: a resource of one of the chat's MCP servers. Not read here: the
 *    message names it and tells the model to read it with `mcp_read_resource`, so the
 *    read goes through the same path as any other (the server must be one of the
 *    chat's own, permission rules and the approval mode apply, and what comes back is
 *    fenced as untrusted text and taints the chat for memory writes).
 *  - `@agent-<name>`: hand the message to that `.houston/agents` subagent, with the
 *    same dispatch prompt `/agent <name>` sends.
 *
 * Only a mention naming something real counts: an unknown agent, a server that isn't
 * configured, or a path that names no file stays text, as `@types/node` does in a
 * template. Expansion is all or nothing, as for templates.
 */

/** Most line ranges and resources one message may pull in. */
const MAX_MENTIONS = 20

/** An `@word` at the start of a word, the way the composer's completion finds one. */
const MENTION_RE = /(^|[\s(])@([^\s`'"(),;<>]+)/g

export interface MessageMentionOptions {
  workspace: string
  /** The workspace roots a file must resolve inside (the workspace first). */
  roots: string[]
  /** The `.houston/agents` names an `@agent-<name>` may hand the message to. */
  agents: readonly string[]
  /** The MCP server ids an `@server:uri` may name. */
  mcpServers: readonly string[]
  /** Ask before reading a credential file. Absent: such a mention is refused. */
  confirm?: (consent: ContextConsent) => Promise<boolean>
}

export type MessageMentionResult =
  /** Nothing to fill in: send the message as typed. */
  | { ok: true; turn: null }
  | { ok: true; turn: InvokedTurn; notes: string[] }
  | { ok: false; error: string }

type Found =
  | { kind: 'agent'; name: string; token: string }
  | { kind: 'range'; path: string; lines: LineRange; token: string }
  | { kind: 'resource'; server: string; uri: string; token: string }

/** The mentions in `text` that name an agent, a file's lines, or an MCP resource. */
export function findMessageMentions(
  text: string,
  known: { agents: readonly string[]; mcpServers: readonly string[] }
): Found[] {
  const out: Found[] = []
  for (const m of text.matchAll(MENTION_RE)) {
    // Sentence punctuation after a mention belongs to the sentence ("see @a.ts#3.").
    const word = m[2].replace(/[.,:;!?]+$/, '')
    if (!word) continue
    const agent = /^agent-([\w-]+)$/.exec(word)?.[1]
    if (agent !== undefined) {
      if (known.agents.includes(agent)) out.push({ kind: 'agent', name: agent, token: `@${word}` })
      continue
    }
    const colon = word.indexOf(':')
    if (colon > 0) {
      const server = word.slice(0, colon)
      const uri = word.slice(colon + 1)
      if (uri && known.mcpServers.includes(server)) {
        out.push({ kind: 'resource', server, uri, token: `@${word}` })
        continue
      }
    }
    const { path, lines } = splitLineRange(word)
    if (lines && path) out.push({ kind: 'range', path, lines, token: `@${word}` })
  }
  return out
}

/** Fill in a message's richer mentions; see the module comment for what each does. */
export async function expandMessageMentions(text: string, opts: MessageMentionOptions): Promise<MessageMentionResult> {
  const found = findMessageMentions(text, opts)
  if (!found.length) return { ok: true, turn: null }
  const agents = found.flatMap((f) => (f.kind === 'agent' ? [f] : []))
  const distinctAgents = [...new Set(agents.map((a) => a.name))]
  if (distinctAgents.length > 1) {
    return { ok: false, error: `the message names ${distinctAgents.length} agents (${distinctAgents.map((a) => `@agent-${a}`).join(', ')}); hand it to one` }
  }
  const rest = found.filter((f) => f.kind !== 'agent')
  if (rest.length > MAX_MENTIONS) {
    return { ok: false, error: `the message pulls in ${rest.length} line ranges and resources; the most is ${MAX_MENTIONS}` }
  }

  // Every file is resolved before anyone is asked anything, so a bad path never costs a prompt.
  const ranges: { abs: string; shown: string; lines: LineRange }[] = []
  const sensitiveFiles: string[] = []
  for (const f of rest) {
    if (f.kind !== 'range') continue
    const r = resolveContextFile(opts.roots, opts.workspace, f.path)
    if (r.kind === 'outside') return { ok: false, error: `${f.token} is outside this project` }
    if (r.kind === 'missing') continue // names no file: it stays text
    ranges.push({ abs: r.abs, shown: r.shown, lines: f.lines })
    if (r.sensitive && !sensitiveFiles.includes(r.shown)) sensitiveFiles.push(r.shown)
  }
  if (sensitiveFiles.length) {
    if (!opts.confirm) return { ok: false, error: 'it reads a credential file, and there is no one here to approve that' }
    if (!(await opts.confirm({ commands: [], sensitiveFiles }))) return { ok: false, error: 'not sent: you declined to share the credential file' }
  }

  const context: string[] = []
  const rangeNames: string[] = []
  for (const r of ranges) {
    const read = await readContextFile(r.abs, r.shown, r.lines)
    if ('error' in read) return { ok: false, error: read.error }
    context.push(read.text)
    rangeNames.push(`${r.shown} lines ${lineRangeLabel(r.lines)}`)
  }
  const describe = [...rangeNames]
  const resources = rest.flatMap((f) => (f.kind === 'resource' ? [f] : []))
  if (resources.length) {
    const seen = new Set<string>()
    const listed = resources.filter((r) => {
      const key = `${r.server}\u0000${r.uri}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    context.push(
      [
        `The message mentions ${listed.length === 1 ? 'an MCP resource' : 'MCP resources'}. Read ${listed.length === 1 ? 'it' : 'each'} with mcp_read_resource before answering:`,
        ...listed.map((r) => `- server ${JSON.stringify(r.server)}, uri ${JSON.stringify(r.uri)}`)
      ].join('\n')
    )
    for (const r of listed) describe.push(`${r.server} resource ${r.uri}`)
  }
  if (!context.length && !distinctAgents.length) return { ok: true, turn: null }

  const agent = distinctAgents[0]
  // The agent mention is how the user chose the agent, not part of its task.
  const task = agent
    ? text
        .replace(new RegExp(`(^|[\\s(])@agent-${agent}(?=$|[\\s.,:;!?)])`, 'g'), '$1')
        .replace(/[ \t]{2,}/g, ' ')
        .trim()
    : text
  const notes: string[] = []
  if (agent) notes.push(`hands this message to the ${agent} subagent`)
  if (rangeNames.length) notes.push(`adds ${rangeNames.join(', ')}`)
  if (resources.length) notes.push('asks the agent to read the MCP resources it names (approval rules apply)')
  return {
    ok: true,
    turn: mentionTurn(text, { ...(agent ? { agent } : {}), task, context, describe: agent ? [`hands it to the ${agent} subagent`, ...describe] : describe }),
    notes
  }
}
