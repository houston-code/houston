/**
 * Resilient edit matching.
 *
 * A model's `old_string` frequently drifts from what's on disk by leading/trailing
 * whitespace, indentation, or a changed middle line — and exact replacement then
 * fails, losing the edit. This applies a cascade of increasingly tolerant matchers
 * and uses the first that locates the text:
 *
 *   1. exact         — verbatim substring (the strict, safe default)
 *   2. line-trimmed   — same lines, ignoring each line's leading/trailing whitespace
 *   3. block-anchor   — for ≥3-line blocks, anchor on the first & last line and
 *                       require the middle to be mostly similar (handles a drifted
 *                       interior while refusing unrelated same-size blocks)
 *
 * The uniqueness contract is preserved: a single match unless `replace_all`. CRLF
 * and a leading BOM are preserved. Pure and deterministic — unit-tested without a
 * filesystem.
 */

export type EditStrategy = 'exact' | 'line-trimmed' | 'block-anchor'

export interface EditResult {
  content: string
  strategy: EditStrategy
  replacements: number
}

interface Span {
  start: number
  end: number
}

const STRATEGIES: EditStrategy[] = ['exact', 'line-trimmed', 'block-anchor']
/** Fraction of a block's interior lines that must still match for block-anchor to fire. */
const MIN_BLOCK_SIMILARITY = 0.5

function splitLines(body: string): { lines: string[]; starts: number[] } {
  const lines = body.split('\n')
  const starts: number[] = []
  let off = 0
  for (const line of lines) {
    starts.push(off)
    off += line.length + 1 // account for the '\n' separator
  }
  return { lines, starts }
}

/** Exact, verbatim occurrences of `needle`, left to right, non-overlapping. */
function exactSpans(body: string, needle: string): Span[] {
  const spans: Span[] = []
  let from = 0
  for (;;) {
    const idx = body.indexOf(needle, from)
    if (idx === -1) break
    spans.push({ start: idx, end: idx + needle.length })
    from = idx + needle.length
  }
  return spans
}

/**
 * Windowed line matches: slide a window of `oldLines.length` lines over the body
 * and keep windows the predicate accepts. Non-overlapping, left to right. When the
 * old text ended in a newline, the span swallows the trailing '\n' so a replacement
 * that also ends in a newline stays symmetric.
 */
function windowSpans(
  body: string,
  oldLines: string[],
  oldHadTrailingNewline: boolean,
  accept: (window: string[]) => boolean
): Span[] {
  const { lines, starts } = splitLines(body)
  const L = oldLines.length
  const spans: Span[] = []
  let i = 0
  while (i + L <= lines.length) {
    const window = lines.slice(i, i + L)
    if (accept(window)) {
      const start = starts[i]
      let end = starts[i + L - 1] + lines[i + L - 1].length
      if (oldHadTrailingNewline && body[end] === '\n') end += 1
      spans.push({ start, end })
      i += L // don't let matches overlap
    } else {
      i += 1
    }
  }
  return spans
}

function lineTrimmedSpans(body: string, oldLines: string[], oldHadTrailingNewline: boolean): Span[] {
  return windowSpans(body, oldLines, oldHadTrailingNewline, (window) =>
    window.every((line, j) => line.trim() === oldLines[j].trim())
  )
}

function blockAnchorSpans(body: string, oldLines: string[], oldHadTrailingNewline: boolean): Span[] {
  const L = oldLines.length
  if (L < 3) return []
  const interior = L - 2
  return windowSpans(body, oldLines, oldHadTrailingNewline, (window) => {
    if (window[0].trim() !== oldLines[0].trim()) return false
    if (window[L - 1].trim() !== oldLines[L - 1].trim()) return false
    let same = 0
    for (let j = 1; j < L - 1; j++) if (window[j].trim() === oldLines[j].trim()) same += 1
    return same / interior >= MIN_BLOCK_SIMILARITY
  })
}

function spansFor(body: string, oldString: string, strategy: EditStrategy): Span[] {
  if (strategy === 'exact') return exactSpans(body, oldString)
  const oldHadTrailingNewline = oldString.endsWith('\n')
  const oldLines = (oldHadTrailingNewline ? oldString.slice(0, -1) : oldString).split('\n')
  // Whitespace-only old text can't be fuzzily located without false positives.
  if (oldLines.every((l) => l.trim() === '')) return []
  return strategy === 'line-trimmed'
    ? lineTrimmedSpans(body, oldLines, oldHadTrailingNewline)
    : blockAnchorSpans(body, oldLines, oldHadTrailingNewline)
}

function splice(body: string, spans: Span[], replacement: string): string {
  let out = ''
  let prev = 0
  for (const s of spans.sort((a, b) => a.start - b.start)) {
    out += body.slice(prev, s.start) + replacement
    prev = s.end
  }
  return out + body.slice(prev)
}

/**
 * Locate `oldString` in `content` via the matcher cascade and replace it with
 * `newString`. Throws a clear error if the text isn't found or is ambiguous
 * (multiple matches without `replaceAll`).
 */
export function resolveEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false
): EditResult {
  if (oldString === '') throw new Error('old_string must not be empty.')
  if (oldString === newString) throw new Error('old_string and new_string are identical.')

  const hasBom = content.charCodeAt(0) === 0xfeff
  const raw = hasBom ? content.slice(1) : content
  // Match and splice in normalized-LF space so CRLF separators are never split
  // across a span boundary, then restore CRLF for the whole result.
  const crlf = raw.includes('\r\n')
  const body = crlf ? raw.replace(/\r\n/g, '\n') : raw
  const oldLf = crlf ? oldString.replace(/\r\n/g, '\n') : oldString
  const newLf = crlf ? newString.replace(/\r\n/g, '\n') : newString

  for (const strategy of STRATEGIES) {
    const spans = spansFor(body, oldLf, strategy)
    if (spans.length === 0) continue
    if (spans.length > 1 && !replaceAll) {
      const via = strategy === 'exact' ? '' : ` (matched via ${strategy})`
      throw new Error(
        `old_string occurs ${spans.length} times${via}; pass replace_all or provide more context.`
      )
    }
    const spliced = splice(body, spans, newLf)
    const next = crlf ? spliced.replace(/\n/g, '\r\n') : spliced
    return {
      content: hasBom ? '\uFEFF' + next : next,
      strategy,
      replacements: spans.length
    }
  }
  throw new Error('old_string was not found in the file.')
}
