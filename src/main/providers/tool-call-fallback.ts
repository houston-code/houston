/**
 * Recovery for OpenAI-compatible servers that emit a model's tool call as plain
 * assistant *text* instead of structured `tool_calls`. Ollama does this on
 * certain model templates (and historically whenever streaming), so a tool call
 * arrives as raw JSON in the content stream — the agent shows it and does
 * nothing, because nothing was ever a real tool call.
 *
 * Two pieces:
 *  - `classifyLead` lets the streaming reader decide, from the first non-blank
 *    characters, whether to hold the content (it looks like a tool call) or
 *    stream it as ordinary text — so a recovered call isn't shown as JSON first.
 *  - `parseTextToolCalls` does the actual recovery once the turn ends.
 *
 * The shapes local models write a call in:
 *  - a bare JSON object or array of them (`{"name": ..., "arguments": {...}}`),
 *    optionally inside a ```json fence;
 *  - Hermes/Qwen `<tool_call>{json}</tool_call>` blocks;
 *  - Qwen3-Coder XML: `<function=name><parameter=key>value</parameter></function>`,
 *    with or without a `<tool_call>` wrapper;
 *  - Mistral `[TOOL_CALLS]`, followed by a JSON array or by `name[ARGS]{json}`.
 * A leading `<think>…</think>` block (reasoning the model wrote into its reply) is
 * skipped first.
 *
 * Both are deliberately strict: recovery only fires when the text cleanly parses
 * to a tool-call shape AND every call names a tool the request actually offered.
 * A model that merely prints JSON (or whose JSON names no real tool) stays text.
 */

import { stripLeadingThink } from './think-tags'

export interface ParsedToolCall {
  name: string
  arguments: Record<string, unknown>
}

const TOOL_CALL_TAG = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g
const FUNCTION_TAG = /<function=([^>\s]+)>([\s\S]*?)<\/function>/g
const PARAMETER_TAG = /<parameter=([^>\s]+)>([\s\S]*?)<\/parameter>/g
const MISTRAL_MARK = '[TOOL_CALLS]'
const ARRAY_OF_OBJECTS = /^\[\s*\{/
const ARRAY_PENDING = /^\[\s*$/
/** A fence opening on a JSON object: ```json\n{ or ```\n{. */
const FENCED_OBJECT = /^```[a-zA-Z]*[ \t]*\r?\n\s*[[{]/
/** A fence still being opened: backticks, an optional language tag, maybe its newline. */
const FENCE_PENDING = /^`{1,3}$|^```[a-zA-Z]*[ \t]*(\r?\n\s*)?$/
const OPENING_TAGS = ['<tool_call>', '<function=']

/**
 * Classify the leading (whitespace-trimmed, non-empty) content of a streamed
 * assistant turn:
 *  - `tool` — starts like a tool call (`{`, `[{`, a `<tool_call>` or `<function=`
 *    block, `[TOOL_CALLS]`, or a fenced JSON object); hold it.
 *  - `text` — ordinary prose; stream it.
 *  - `wait` — an ambiguous prefix (a partial tag, a lone `[`, an opening fence);
 *    not enough yet to decide, so keep buffering.
 */
export function classifyLead(lead: string): 'tool' | 'text' | 'wait' {
  if (lead.startsWith('{')) return 'tool'
  if (OPENING_TAGS.some((t) => lead.startsWith(t))) return 'tool'
  if (lead.startsWith(MISTRAL_MARK)) return 'tool'
  // A strict prefix of an opening tag: more characters may complete it.
  if (OPENING_TAGS.some((t) => t.startsWith(lead)) || MISTRAL_MARK.startsWith(lead)) return 'wait'
  if (lead.startsWith('[')) {
    if (ARRAY_OF_OBJECTS.test(lead)) return 'tool'
    if (ARRAY_PENDING.test(lead)) return 'wait'
    return 'text' // `[` followed by non-object content, e.g. "[1] note"
  }
  if (lead.startsWith('`')) {
    if (FENCED_OBJECT.test(lead)) return 'tool'
    if (FENCE_PENDING.test(lead)) return 'wait'
    return 'text'
  }
  return 'text'
}

/**
 * Recover tool calls written as text. Returns the calls when `content` is a clean
 * tool-call payload in one of the shapes above and every name is in
 * `knownToolNames`. Returns null otherwise, so the caller keeps treating the
 * content as text.
 */
export function parseTextToolCalls(
  content: string,
  knownToolNames: ReadonlySet<string>
): ParsedToolCall[] | null {
  const trimmed = stripLeadingThink(content).trim()
  if (!trimmed) return null

  const raw = rawCalls(trimmed)
  if (!raw) return null

  const calls: ParsedToolCall[] = []
  for (const item of raw) {
    const call = toToolCall(item)
    if (!call || !knownToolNames.has(call.name)) return null
    calls.push(call)
  }
  return calls.length ? calls : null
}

/** The call-shaped values in `text`, or null when it isn't a clean tool-call payload. */
function rawCalls(text: string): unknown[] | null {
  if (text.includes('<function=')) return xmlCalls(text)
  if (text.includes('<tool_call>')) {
    const blocks: unknown[] = []
    for (const m of text.matchAll(TOOL_CALL_TAG)) {
      const parsed = tryParseJson(m[1])
      if (parsed === undefined) return null
      blocks.push(parsed)
    }
    return blocks.length ? blocks : null
  }
  if (text.startsWith(MISTRAL_MARK)) return mistralCalls(text.slice(MISTRAL_MARK.length).trim())
  const body = unfence(text)
  if (body === null) return null
  const parsed = tryParseJson(body)
  if (parsed === undefined) return null
  return Array.isArray(parsed) ? parsed : [parsed]
}

/** The inside of a single ```-fenced block that is the whole text, or the text itself. */
function unfence(text: string): string | null {
  if (!text.startsWith('```')) return text
  const m = /^```[a-zA-Z]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/.exec(text)
  return m ? m[1] : null
}

/**
 * Qwen3-Coder's XML calls. Everything outside the `<function=…>` blocks must be
 * `<tool_call>` wrappers or whitespace, so prose that mentions the syntax stays text.
 * A parameter's value is JSON when it parses as JSON, otherwise the string itself.
 */
function xmlCalls(text: string): unknown[] | null {
  const calls: unknown[] = []
  const rest = text.replace(FUNCTION_TAG, (_m, name: string, body: string) => {
    const args: Record<string, unknown> = {}
    const leftover = body.replace(PARAMETER_TAG, (_p, key: string, value: string) => {
      args[key] = xmlValue(value)
      return ''
    })
    if (leftover.trim()) calls.push(null) // stray text inside the call: not a clean call
    else calls.push({ name, arguments: args })
    return ''
  })
  if (rest.replace(/<\/?tool_call>/g, '').trim()) return null
  return calls.length ? calls : null
}

function xmlValue(raw: string): unknown {
  // The template puts each value on its own line; those newlines aren't part of it.
  const value = raw.replace(/^\r?\n/, '').replace(/\r?\n$/, '')
  const parsed = tryParseJson(value)
  // Only structured or literal JSON replaces the string: a bare word stays a string.
  return parsed !== undefined && (typeof parsed !== 'string' || /^\s*"/.test(value)) ? parsed : value
}

/** Mistral: a JSON array (or object) of calls, or one or more `name[ARGS]{json}` calls. */
function mistralCalls(text: string): unknown[] | null {
  if (text.startsWith('[') || text.startsWith('{')) {
    const parsed = tryParseJson(text)
    if (parsed === undefined) return null
    return Array.isArray(parsed) ? parsed : [parsed]
  }
  const calls: unknown[] = []
  for (const part of text.split(MISTRAL_MARK)) {
    const m = /^\s*([A-Za-z0-9_.:-]+)\[ARGS\]([\s\S]*)$/.exec(part)
    if (!m) return null
    const args = tryParseJson(m[2])
    if (args === undefined) return null
    calls.push({ name: m[1], arguments: args })
  }
  return calls.length ? calls : null
}

function tryParseJson(s: string): unknown | undefined {
  try {
    return JSON.parse(s.trim())
  } catch {
    return undefined
  }
}

function toToolCall(item: unknown): ParsedToolCall | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null
  const obj = item as Record<string, unknown>
  if (typeof obj.name !== 'string' || !obj.name) return null

  const rawArgs = obj.arguments ?? obj.parameters ?? {}
  let args: Record<string, unknown>
  if (typeof rawArgs === 'string') {
    if (rawArgs.trim() === '') {
      args = {}
    } else {
      const parsed = tryParseJson(rawArgs)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
      args = parsed as Record<string, unknown>
    }
  } else if (typeof rawArgs === 'object' && rawArgs !== null && !Array.isArray(rawArgs)) {
    args = rawArgs as Record<string, unknown>
  } else {
    return null
  }
  return { name: obj.name, arguments: args }
}
