/**
 * ANSI-aware text measurement and wrapping for the terminal UI. Colorized strings
 * carry SGR escape sequences (`\x1b[…m`) that occupy zero visible columns, so a
 * naive `.length` over-counts and a naive wrap breaks early / mid-escape. These
 * helpers measure and wrap by *visible* width, leaving the color codes intact.
 */

// ESC (0x1b). Built from a char code so no control character appears in source
// (a literal ESC in a regex trips eslint's no-control-regex).
const ESC = String.fromCharCode(27)
// Matches a CSI SGR (color/style) sequence — the only escapes the renderer emits.
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'g')

/** Strip SGR color codes, leaving the visible text. */
export function stripAnsi(s: string): string {
  return s.replace(SGR, '')
}

/**
 * Display columns a single code point occupies: 0 for combining/zero-width marks,
 * 2 for East-Asian wide + fullwidth glyphs and astral emoji, 1 otherwise. A
 * pragmatic wcwidth (not exhaustive) so CJK / emoji don't miscount and overflow
 * the status line, and so truncation never lands mid-wide-char. `.length` counted
 * these as 1 (or, for astral chars, as 2 code units), which was wrong both ways.
 */
export function charWidth(cp: number): number {
  if ((cp >= 0x0300 && cp <= 0x036f) || cp === 0x200b || (cp >= 0x200c && cp <= 0x200f) || cp === 0xfeff) {
    return 0 // combining marks / zero-width
  }
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) || // CJK, Kana, … Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth forms
    (cp >= 0x1f000 && cp <= 0x1faff) || // emoji & pictographs
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK Ext B+
  ) {
    return 2
  }
  return 1
}

/** Visible column width of a string: sums per-code-point width, ignoring SGR escapes. */
export function visibleWidth(s: string): number {
  let w = 0
  for (const ch of stripAnsi(s)) w += charWidth(ch.codePointAt(0) ?? 0)
  return w
}

/**
 * Truncate to at most `max` visible columns, appending `ellipsis` when cut. SGR
 * codes don't count toward the width; a trailing reset is preserved if present so
 * color never bleeds past the cut.
 */
export function truncateVisible(s: string, max: number, ellipsis = '…'): string {
  if (visibleWidth(s) <= max) return s
  const keep = Math.max(0, max - visibleWidth(ellipsis))
  let out = ''
  let shown = 0
  let i = 0
  while (i < s.length) {
    const m = matchSgrAt(s, i)
    if (m) {
      out += m
      i += m.length
      continue
    }
    const cp = s.codePointAt(i) ?? 0
    const ch = String.fromCodePoint(cp)
    const w = charWidth(cp)
    if (shown + w > keep) break // stop before a partial/over-width char
    out += ch
    shown += w
    i += ch.length // advance a full code point (never split a surrogate pair)
  }
  const hadColor = out.includes(`${ESC}[`)
  return `${out}${ellipsis}${hadColor ? `${ESC}[0m` : ''}`
}

/**
 * Word-wrap to `width` visible columns. Words longer than `width` are hard-split.
 * SGR codes pass through and don't count toward the width. Existing newlines are
 * preserved as hard breaks.
 */
export function wrapAnsi(s: string, width: number): string {
  if (width <= 0) return s
  return s
    .split('\n')
    .map((line) => wrapLine(line, width))
    .join('\n')
}

function wrapLine(line: string, width: number): string {
  if (visibleWidth(line) <= width) return line
  const words = line.split(' ')
  const out: string[] = []
  let cur = ''
  const push = (): void => {
    if (cur) out.push(cur)
    cur = ''
  }
  for (const word of words) {
    if (visibleWidth(word) > width) {
      // A single word longer than the line — hard-split it.
      push()
      for (const chunk of hardSplit(word, width)) out.push(chunk)
      continue
    }
    const candidate = cur ? `${cur} ${word}` : word
    if (visibleWidth(candidate) > width) {
      push()
      cur = word
    } else {
      cur = candidate
    }
  }
  push()
  return out.join('\n')
}

function hardSplit(word: string, width: number): string[] {
  const chunks: string[] = []
  let cur = ''
  let shown = 0
  let i = 0
  while (i < word.length) {
    const m = matchSgrAt(word, i)
    if (m) {
      cur += m
      i += m.length
      continue
    }
    const cp = word.codePointAt(i) ?? 0
    const ch = String.fromCodePoint(cp)
    const w = charWidth(cp)
    // Break before a char that would overflow the row (only if we've placed one).
    if (cur && shown + w > width) {
      chunks.push(cur)
      cur = ''
      shown = 0
    }
    cur += ch
    shown += w
    i += ch.length // full code point (never split a surrogate pair)
  }
  if (cur) chunks.push(cur)
  return chunks
}

/** If an SGR escape starts at index `i`, return it; else null. */
function matchSgrAt(s: string, i: number): string | null {
  if (s[i] !== ESC) return null
  SGR.lastIndex = i
  const m = SGR.exec(s)
  return m && m.index === i ? m[0] : null
}
