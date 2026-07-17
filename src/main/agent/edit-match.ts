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
 * When a fuzzy tier matches, the replacement is re-indented to the block it actually
 * landed on: the model authors `new_string` relative to whatever indentation it put
 * in `old_string`, so splicing it in verbatim would stamp the model's indentation
 * over the file's (silently flattening a nested block, or injecting indentation the
 * file never had). Instead we swap the old block's base indent for the file block's
 * and keep each replacement line's indentation *relative* to that base, so nesting
 * inside the block survives. Exact matches already agree with the file, so they are
 * spliced verbatim.
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
  /** Common leading indent of the matched window; set only for fuzzy matches. */
  indent?: string
}

interface Replacement {
  start: number
  end: number
  text: string
}

const STRATEGIES: EditStrategy[] = ['exact', 'line-trimmed', 'block-anchor']
/** Fraction of a block's interior lines that must still match for block-anchor to fire. */
const MIN_BLOCK_SIMILARITY = 0.5

/** Leading run of spaces/tabs; other whitespace (e.g. form feed) is not treated as indent. */
function leadingIndent(line: string): string {
  const m = /^[ \t]*/.exec(line)
  return m ? m[0] : ''
}

/**
 * The whitespace prefix common to every non-blank line — the block's base indent.
 * Blank lines are ignored so they don't collapse the prefix to empty.
 */
function commonIndent(lines: string[]): string {
  let prefix: string | null = null
  for (const line of lines) {
    if (line.trim() === '') continue
    const lead = leadingIndent(line)
    if (prefix === null) {
      prefix = lead
      continue
    }
    let k = 0
    while (k < prefix.length && k < lead.length && prefix[k] === lead[k]) k++
    prefix = prefix.slice(0, k)
    if (prefix === '') break
  }
  return prefix ?? ''
}

/**
 * Re-base the replacement onto the file block's indentation: strip the part of each
 * line's leading whitespace it shares with `oldBase` (what the model indented to),
 * then prepend `fileBase` (what the file actually uses). Whitespace nested deeper
 * than the base is kept, so structure inside the block survives. Blank lines pass
 * through untouched so we never emit whitespace-only lines.
 */
function reindent(newLines: string[], oldBase: string, fileBase: string): string[] {
  if (oldBase === fileBase) return newLines
  return newLines.map((line) => {
    if (line.trim() === '') return line
    const lead = leadingIndent(line)
    let k = 0
    while (k < lead.length && k < oldBase.length && lead[k] === oldBase[k]) k++
    return fileBase + line.slice(k)
  })
}

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
 * that also ends in a newline stays symmetric. Each span records the window's base
 * indent so the replacement can be re-indented to where it landed.
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
      spans.push({ start, end, indent: commonIndent(window) })
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

/**
 * Splice per-span replacement text into the RAW string at spans expressed as offsets
 * in the LF-normalized `body`, leaving every unmatched region byte-for-byte identical.
 * Walks `raw` once, counting `\r\n` as the single `\n` it collapses to in `body`. This
 * keeps a mixed line-ending file's untouched lines on their original terminators,
 * instead of re-encoding the whole file (which flipped every bare LF to CRLF).
 */
function spliceRaw(raw: string, replacements: Replacement[]): string {
  const sorted = replacements.slice().sort((a, b) => a.start - b.start)
  const step = (ri: number): number => (raw[ri] === '\r' && raw[ri + 1] === '\n' ? 2 : 1)
  let out = ''
  let ri = 0 // raw offset
  let bi = 0 // body (LF) offset
  let prevRaw = 0
  for (const r of sorted) {
    while (bi < r.start) { ri += step(ri); bi++ }
    const rawStart = ri
    while (bi < r.end) { ri += step(ri); bi++ }
    out += raw.slice(prevRaw, rawStart) + r.text
    prevRaw = ri
  }
  return out + raw.slice(prevRaw)
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
  if (oldString === newString)
    throw new Error(
      'old_string and new_string are identical, so the edit would make no change. Make the replacement text differ from the original.'
    )

  const hasBom = content.charCodeAt(0) === 0xfeff
  const raw = hasBom ? content.slice(1) : content
  // Match in normalized-LF space so CRLF separators are never split across a span
  // boundary, but splice back into RAW so untouched lines keep their original endings.
  const crlf = raw.includes('\r\n')
  const body = crlf ? raw.replace(/\r\n/g, '\n') : raw
  const oldLf = crlf ? oldString.replace(/\r\n/g, '\n') : oldString
  const newLf = crlf ? newString.replace(/\r\n/g, '\n') : newString

  const oldHadTrailingNewline = oldLf.endsWith('\n')
  const oldLines = (oldHadTrailingNewline ? oldLf.slice(0, -1) : oldLf).split('\n')
  const oldAllBlank = oldLines.every((l) => l.trim() === '')
  const oldBase = commonIndent(oldLines)

  const newHadTrailingNewline = newLf.endsWith('\n')
  const newLines = (newHadTrailingNewline ? newLf.slice(0, -1) : newLf).split('\n')

  // Re-assemble replacement lines back into the file's dominant line ending; the rest
  // of the file is preserved verbatim (see spliceRaw), so a mixed-ending file isn't
  // rewritten. Passing `newLines` straight through reproduces `newString` exactly.
  const encode = (lines: string[]): string => {
    const joined = lines.join('\n') + (newHadTrailingNewline ? '\n' : '')
    return crlf ? joined.replace(/\n/g, '\r\n') : joined
  }

  for (const strategy of STRATEGIES) {
    let spans: Span[]
    if (strategy === 'exact') {
      spans = exactSpans(body, oldLf)
    } else if (oldAllBlank) {
      // Whitespace-only old text can't be fuzzily located without false positives.
      continue
    } else {
      spans =
        strategy === 'line-trimmed'
          ? lineTrimmedSpans(body, oldLines, oldHadTrailingNewline)
          : blockAnchorSpans(body, oldLines, oldHadTrailingNewline)
    }
    if (spans.length === 0) continue
    if (spans.length > 1 && !replaceAll) {
      const via = strategy === 'exact' ? '' : ` (matched via ${strategy})`
      throw new Error(
        `old_string occurs ${spans.length} times${via}; pass replace_all or provide more context.`
      )
    }

    const replacements: Replacement[] = spans.map((s) => ({
      start: s.start,
      end: s.end,
      // Fuzzy spans carry the file block's indent; re-base the replacement onto it.
      text: s.indent !== undefined ? encode(reindent(newLines, oldBase, s.indent)) : encode(newLines)
    }))
    const next = spliceRaw(raw, replacements)
    return {
      content: hasBom ? '\uFEFF' + next : next,
      strategy,
      replacements: spans.length
    }
  }
  throw new Error('old_string was not found in the file.')
}
