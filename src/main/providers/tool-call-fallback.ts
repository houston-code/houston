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
 * Both are deliberately strict: recovery only fires when the text cleanly parses
 * to a tool-call shape AND every call names a tool the request actually offered.
 * A model that merely prints JSON (or whose JSON names no real tool) stays text.
 */

export interface ParsedToolCall {
  name: string
  arguments: Record<string, unknown>
}

const TOOL_CALL_TAG = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g
const ARRAY_OF_OBJECTS = /^\[\s*\{/
const ARRAY_PENDING = /^\[\s*$/

/**
 * Classify the leading (whitespace-trimmed, non-empty) content of a streamed
 * assistant turn:
 *  - `tool` — starts like a tool call (`{`, `[{`, or a `<tool_call>` block); hold it.
 *  - `text` — ordinary prose; stream it.
 *  - `wait` — an ambiguous prefix (`<`, partial `<tool_call>`, or a lone `[`);
 *    not enough yet to decide, so keep buffering.
 */
export function classifyLead(lead: string): 'tool' | 'text' | 'wait' {
  if (lead.startsWith('{')) return 'tool'
  if (lead.startsWith('<tool_call>')) return 'tool'
  // A strict prefix of the opening tag — more characters may complete it.
  if ('<tool_call>'.startsWith(lead)) return 'wait'
  if (lead.startsWith('[')) {
    if (ARRAY_OF_OBJECTS.test(lead)) return 'tool'
    if (ARRAY_PENDING.test(lead)) return 'wait'
    return 'text' // `[` followed by non-object content, e.g. "[1] note"
  }
  return 'text'
}

/**
 * Recover tool calls written as text. Returns the calls when `content` is a clean
 * tool-call payload — a single object, an array of objects, or one or more
 * `<tool_call>` blocks — and every name is in `knownToolNames`. Returns null
 * otherwise, so the caller keeps treating the content as text.
 */
export function parseTextToolCalls(
  content: string,
  knownToolNames: ReadonlySet<string>
): ParsedToolCall[] | null {
  const trimmed = content.trim()
  if (!trimmed) return null

  let raw: unknown[]
  if (trimmed.includes('<tool_call>')) {
    const blocks: unknown[] = []
    for (const m of trimmed.matchAll(TOOL_CALL_TAG)) {
      const parsed = tryParseJson(m[1])
      if (parsed === undefined) return null
      blocks.push(parsed)
    }
    if (!blocks.length) return null
    raw = blocks
  } else {
    const parsed = tryParseJson(trimmed)
    if (parsed === undefined) return null
    raw = Array.isArray(parsed) ? parsed : [parsed]
  }

  const calls: ParsedToolCall[] = []
  for (const item of raw) {
    const call = toToolCall(item)
    if (!call || !knownToolNames.has(call.name)) return null
    calls.push(call)
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
