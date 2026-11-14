/**
 * Keep every ACP frame (one JSON-RPC message on one line) under a size a line-based
 * reader can take. A client built on asyncio's `StreamReader.readline` (the Python
 * ACP SDK's spawn helpers, unless the caller raises the limit) fails on any line over
 * 64 KiB and drops the whole connection, so one big diff or pasted image ends the run.
 *
 * Only the display payload of a tool call is ever shrunk: its content blocks, its
 * rawInput and its rawOutput. Ids, statuses, titles and every other method's frames
 * are sent as they are. Shrinking runs in steps from least to most lossy, and stops
 * at the first one that fits:
 *   1. images become a short text note (a partial base64 image is useless);
 *   2. long string values in rawInput / rawOutput are shortened;
 *   3. each diff keeps only the region that changed, with a few lines of context;
 *   4. the remaining long strings are shortened, with a tighter cap each pass;
 *   5. the content is replaced by one note and the raw fields dropped.
 */

/** Largest frame sent, in UTF-8 bytes including the newline: headroom under 64 KiB. */
export const ACP_MAX_FRAME_BYTES = 60 * 1024

const RAW_STRING_CAP = 2_000
const DIFF_CONTEXT_LINES = 3
const MIN_STRING_CAP = 256

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8') + 1

function shorten(s: string, cap: number): string {
  return s.length > cap ? `${s.slice(0, cap)}\n… (shortened to fit one message)` : s
}

/** Every string leaf longer than `cap`, shortened (keys and structure kept). */
function shortenStrings(v: unknown, cap: number): unknown {
  if (typeof v === 'string') return shorten(v, cap)
  if (Array.isArray(v)) return v.map((x) => shortenStrings(x, cap))
  if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shortenStrings(x, cap)]))
  return v
}

const marker = (n: number): string => `⋯ ${n} unchanged line${n === 1 ? '' : 's'}`

/**
 * A diff cut down to the lines that changed, with context, the unchanged runs
 * around it folded into one marker line on both sides (as an approval preview does).
 */
export function compactDiffTexts(oldText: string, newText: string, context = DIFF_CONTEXT_LINES): { oldText: string; newText: string } {
  const a = oldText.split('\n')
  const b = newText.split('\n')
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const head = Math.max(0, pre - context)
  const tail = Math.max(0, suf - context)
  const cut = (lines: string[]): string => {
    const out = lines.slice(head, lines.length - tail)
    if (head > 0) out.unshift(marker(head))
    if (tail > 0) out.push(marker(tail))
    return out.join('\n')
  }
  return { oldText: cut(a), newText: cut(b) }
}

function mapContent(target: Json, f: (block: Json) => Json): void {
  if (Array.isArray(target.content)) {
    target.content = target.content.map((c) => (isObject(c) ? f(c) : c))
  } else if (isObject(target.content)) {
    // A single content block, as on a message chunk.
    const wrapped = f({ type: 'content', content: target.content })
    target.content = isObject(wrapped.content) ? wrapped.content : wrapped
  }
}

const imageNote = (block: Json): Json => ({
  type: 'text',
  text: `[image (${typeof block.mimeType === 'string' ? block.mimeType : 'image'}) not shown: too large for one message]`
})

const steps: ((t: Json) => void)[] = [
  (t) =>
    mapContent(t, (c) =>
      c.type === 'content' && isObject(c.content) && c.content.type === 'image' ? { ...c, content: imageNote(c.content) } : c
    ),
  (t) => {
    for (const k of ['rawInput', 'rawOutput']) if (k in t) t[k] = shortenStrings(t[k], RAW_STRING_CAP)
  },
  (t) =>
    mapContent(t, (c) =>
      c.type === 'diff' && typeof c.oldText === 'string' && typeof c.newText === 'string'
        ? { ...c, ...compactDiffTexts(c.oldText, c.newText) }
        : c
    )
]

/** Where a frame's tool-call display payload lives, if it has one. */
function payloadOf(m: Json): { holder: Json; key: string } | null {
  const params = m.params
  if (!isObject(params)) return null
  if (m.method === 'session/update' && isObject(params.update)) return { holder: params, key: 'update' }
  if (m.method === 'session/request_permission' && isObject(params.toolCall)) return { holder: params, key: 'toolCall' }
  return null
}

/**
 * The frame as one line of JSON (no trailing newline), shrunk to fit `max` bytes
 * when it is a tool-call update or permission request that would not. A frame that
 * still does not fit after every step is returned as small as it got.
 */
export function fitAcpFrame(m: Json, max = ACP_MAX_FRAME_BYTES): string {
  let line = JSON.stringify(m)
  if (bytes(line) <= max) return line
  const at = payloadOf(m)
  if (!at) return line
  const params = at.holder
  // A copy, so the caller's object (and anything it shares) is left alone.
  const target: Json = JSON.parse(JSON.stringify(params[at.key])) as Json
  const render = (): string => JSON.stringify({ ...m, params: { ...params, [at.key]: target } })
  for (const step of steps) {
    step(target)
    line = render()
    if (bytes(line) <= max) return line
  }
  for (let cap = 16_000; cap >= MIN_STRING_CAP; cap = Math.floor(cap / 2)) {
    if ('content' in target) target.content = shortenStrings(target.content, cap)
    for (const k of ['rawInput', 'rawOutput']) if (k in target) target[k] = shortenStrings(target[k], cap)
    line = render()
    if (bytes(line) <= max) return line
  }
  if ('content' in target) {
    target.content = Array.isArray(target.content)
      ? [{ type: 'content', content: { type: 'text', text: '[output not shown: too large for one message]' } }]
      : { type: 'text', text: '[not shown: too large for one message]' }
  }
  delete target.rawInput
  delete target.rawOutput
  return render()
}
