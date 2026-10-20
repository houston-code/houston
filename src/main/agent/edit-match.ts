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
 *
 * Two recoveries sit around the cascade. When `old_string` matches nowhere as
 * written but every line of it carries a `read_file` line-number prefix, the
 * prefixes are taken to be copied by mistake and the cascade is retried without
 * them (see {@link stripLineNumbers}). When nothing matches at all, the error names
 * the closest region of the file, numbered, so the model can correct its
 * `old_string` without re-reading the whole file.
 */

import { displayLines, numberLines, numberWidth, stripLineNumbers } from './line-numbers'

export type EditStrategy = 'exact' | 'line-trimmed' | 'block-anchor'

/** Where one replacement landed, in the line numbers of the edited content. */
export interface EditRegion {
  /** 1-based line the replacement starts on. */
  startLine: number
  /** Lines the replacement occupies; 0 when it deleted text without adding any. */
  lineCount: number
  /** Lines the replacement added (negative: removed), which shifts every later line. */
  lineDelta: number
}

export interface EditResult {
  content: string
  strategy: EditStrategy
  replacements: number
  /** Each replacement's position in `content`, in file order. */
  regions: EditRegion[]
  /**
   * Set when `old_string` matched only after removing copied line-number prefixes;
   * `'old'` when just `old_string` carried them, `'both'` when `new_string` did too.
   */
  strippedLineNumbers?: 'old' | 'both'
}

/**
 * `old_string` matched nothing. Carries whether the message names a closest region,
 * so a caller that applies several edits in memory can say which state its line
 * numbers describe.
 */
export class EditNotFoundError extends Error {
  constructor(
    message: string,
    readonly hasCandidate: boolean
  ) {
    super(message)
    this.name = 'EditNotFoundError'
  }
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

/** The file text a match runs against: BOM split off, line endings normalized to LF. */
interface Prepared {
  hasBom: boolean
  /** The content without its BOM, line endings as on disk. */
  raw: string
  crlf: boolean
  /** `raw` with CRLF normalized to LF; every span offset is into this. */
  body: string
}

function prepare(content: string): Prepared {
  const hasBom = content.charCodeAt(0) === 0xfeff
  const raw = hasBom ? content.slice(1) : content
  // Match in normalized-LF space so CRLF separators are never split across a span
  // boundary, but splice back into RAW so untouched lines keep their original endings.
  const crlf = raw.includes('\r\n')
  return { hasBom, raw, crlf, body: crlf ? raw.replace(/\r\n/g, '\n') : raw }
}

/** Number of `\n` in `s[from, to)`. */
function countNewlines(s: string, from = 0, to = s.length): number {
  let n = 0
  for (let i = from; i < to; i++) if (s.charCodeAt(i) === 10) n++
  return n
}

/**
 * Run the matcher cascade for one `oldString`/`newString` pair. Returns the edit, or
 * null when no strategy locates the text. Throws when a strategy finds it more than
 * once without `replaceAll`: an ambiguous match is an answer, not a miss.
 */
function locate(
  p: Prepared,
  oldString: string,
  newString: string,
  replaceAll: boolean
): Omit<EditResult, 'strippedLineNumbers'> | null {
  const { body, crlf } = p
  const oldLf = crlf ? oldString.replace(/\r\n/g, '\n') : oldString
  const newLf = crlf ? newString.replace(/\r\n/g, '\n') : newString

  const oldHadTrailingNewline = oldLf.endsWith('\n')
  const oldLines = (oldHadTrailingNewline ? oldLf.slice(0, -1) : oldLf).split('\n')
  const oldAllBlank = oldLines.every((l) => l.trim() === '')
  const oldBase = commonIndent(oldLines)

  const newHadTrailingNewline = newLf.endsWith('\n')
  const newLines = (newHadTrailingNewline ? newLf.slice(0, -1) : newLf).split('\n')

  // The replacement in LF form; passing `newLines` straight through reproduces
  // `newString` exactly. Re-encoded into the file's dominant line ending when spliced,
  // and the rest of the file is preserved verbatim (see spliceRaw), so a mixed-ending
  // file isn't rewritten.
  const joinLf = (lines: string[]): string => lines.join('\n') + (newHadTrailingNewline ? '\n' : '')

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

    // Fuzzy spans carry the file block's indent; re-base the replacement onto it.
    const texts = spans.map((s) => joinLf(s.indent !== undefined ? reindent(newLines, oldBase, s.indent) : newLines))
    const replacements: Replacement[] = spans.map((s, i) => ({
      start: s.start,
      end: s.end,
      text: crlf ? texts[i].replace(/\n/g, '\r\n') : texts[i]
    }))
    // Spans are left to right and non-overlapping, so each one's start line in the
    // edited content is its start line in the original plus what earlier ones added.
    const regions: EditRegion[] = []
    let shift = 0
    let cursor = 0
    let linesBefore = 0
    spans.forEach((s, i) => {
      linesBefore += countNewlines(body, cursor, s.start)
      cursor = s.start
      const text = texts[i]
      const added = countNewlines(text)
      const lineDelta = added - countNewlines(body, s.start, s.end)
      regions.push({
        startLine: 1 + linesBefore + shift,
        lineCount: text === '' ? 0 : added + (text.endsWith('\n') ? 0 : 1),
        lineDelta
      })
      shift += lineDelta
    })
    const next = spliceRaw(p.raw, replacements)
    return {
      content: p.hasBom ? '﻿' + next : next,
      strategy,
      replacements: spans.length,
      regions
    }
  }
  return null
}

/**
 * Locate `oldString` in `content` via the matcher cascade and replace it with
 * `newString`. Throws a clear error if the text isn't found or is ambiguous
 * (multiple matches without `replaceAll`). A miss is an {@link EditNotFoundError}
 * naming the closest region, when one is close enough to be worth showing and
 * `showCandidate` isn't false (a caller editing a credential file turns it off, so
 * a deliberately wrong old_string can't read the file out through the error).
 */
export function resolveEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false,
  opts: { showCandidate?: boolean } = {}
): EditResult {
  if (oldString === '') throw new Error('old_string must not be empty.')
  if (oldString === newString) throw identicalError()

  const p = prepare(content)
  const hit = locate(p, oldString, newString, replaceAll)
  if (hit) return hit

  // Not found as written. If every line carries a read_file prefix, the model copied
  // the numbers along with the text: retry without them. new_string is stripped only
  // in that case, and only when all of its lines are numbered too, so a replacement
  // that merely starts with numbers is written as given.
  const strippedOld = stripLineNumbers(oldString, { consecutive: true })
  if (strippedOld !== null && strippedOld.trim() !== '') {
    const strippedNew = stripLineNumbers(newString)
    const retryNew = strippedNew ?? newString
    if (strippedOld === retryNew) throw identicalError()
    const retry = locate(p, strippedOld, retryNew, replaceAll)
    if (retry) return { ...retry, strippedLineNumbers: strippedNew !== null ? 'both' : 'old' }
  }
  if (opts.showCandidate === false) {
    throw new EditNotFoundError(
      'old_string was not found in the file. Its closest region is not shown because the file may hold credentials; read it with read_file to see its current content.',
      false
    )
  }
  throw notFoundError(p.body, strippedOld !== null && strippedOld.trim() !== '' ? strippedOld : oldString)
}

function identicalError(): Error {
  return new Error(
    'old_string and new_string are identical, so the edit would make no change. Make the replacement text differ from the original.'
  )
}

/** Lines of a candidate region shown in a not-found error before it is cut short. */
const MAX_CANDIDATE_LINES = 40
/** How similar (0..1) a region must be to `old_string` to be offered as the one meant. */
const MIN_CANDIDATE_SIMILARITY = 0.4
/** Line comparisons the closest-region scan may spend before narrowing what it compares. */
const MAX_CANDIDATE_COMPARISONS = 2_000_000

function notFoundError(body: string, oldString: string): EditNotFoundError {
  const lines = displayLines(body)
  const needle = displayLines(oldString.replace(/\r\n/g, '\n'))
  const best = closestRegion(lines, needle)
  if (!best || best.score < MIN_CANDIDATE_SIMILARITY) {
    return new EditNotFoundError(
      'old_string was not found in the file, and no part of the file is close to it. Read the file again to see its current content.',
      false
    )
  }
  const from = best.start + 1
  const to = best.start + best.length
  const shownTo = Math.min(to, from + MAX_CANDIDATE_LINES - 1)
  const listing = numberLines(lines, from, shownTo, numberWidth(lines.length))
  const cut = shownTo < to ? `\n[${to - shownTo} more line${to - shownTo === 1 ? '' : 's'} not shown]` : ''
  const range = from === to ? `line ${from}` : `lines ${from}-${to}`
  return new EditNotFoundError(
    `old_string was not found in the file. The closest match is ${range} (${Math.round(best.score * 100)}% similar):\n${listing}${cut}\nIf this is the text you meant, retry with old_string copied from it exactly, without the line-number prefixes.`,
    true
  )
}

/** A line's comparable tokens: identifier/number runs and punctuation runs. */
function tokens(line: string): Set<string> {
  return new Set(line.trim().match(/[\p{L}\p{N}_$]+|[^\s\p{L}\p{N}_$]+/gu) ?? [])
}

/** Similarity of two lines in 0..1: 1 when equal ignoring outer whitespace, else token-set Dice. */
function lineSimilarity(a: string, ta: Set<string>, b: string, tb: Set<string>): number {
  if (a.trim() === b.trim()) return 1
  if (ta.size === 0 || tb.size === 0) return 0
  let shared = 0
  for (const t of ta) if (tb.has(t)) shared++
  return (2 * shared) / (ta.size + tb.size)
}

/**
 * The window of the file most like `needle`, line by line: every run of
 * `needle.length` consecutive lines is scored by its mean per-line similarity, and
 * the first best wins. Blank lines at either end of the needle are ignored, since
 * they say nothing about where it belongs. On a very large file the needle is cut to
 * its leading lines so the scan stays bounded; its head still finds the region.
 */
function closestRegion(
  lines: string[],
  rawNeedle: string[]
): { start: number; length: number; score: number } | null {
  let lo = 0
  let hi = rawNeedle.length
  while (lo < hi && rawNeedle[lo].trim() === '') lo++
  while (hi > lo && rawNeedle[hi - 1].trim() === '') hi--
  let needle = rawNeedle.slice(lo, hi)
  if (needle.length === 0 || lines.length === 0) return null
  const fullLength = Math.min(needle.length, lines.length)
  const budget = Math.max(1, Math.floor(MAX_CANDIDATE_COMPARISONS / lines.length))
  needle = needle.slice(0, Math.min(fullLength, budget))

  const fileTokens = lines.map(tokens)
  const needleTokens = needle.map(tokens)
  let best: { start: number; length: number; score: number } | null = null
  for (let i = 0; i + needle.length <= lines.length; i++) {
    let sum = 0
    for (let j = 0; j < needle.length; j++) {
      sum += lineSimilarity(lines[i + j], fileTokens[i + j], needle[j], needleTokens[j])
    }
    const score = sum / needle.length
    if (!best || score > best.score) best = { start: i, length: fullLength, score }
  }
  if (best && best.start + best.length > lines.length) best.length = lines.length - best.start
  return best
}
