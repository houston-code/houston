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

/** Visible column width of a string, ignoring SGR escapes. */
export function visibleWidth(s: string): number {
  return stripAnsi(s).length
}

/**
 * Truncate to at most `max` visible columns, appending `ellipsis` when cut. SGR
 * codes don't count toward the width; a trailing reset is preserved if present so
 * color never bleeds past the cut.
 */
export function truncateVisible(s: string, max: number, ellipsis = '…'): string {
  if (visibleWidth(s) <= max) return s
  const keep = Math.max(0, max - ellipsis.length)
  let out = ''
  let shown = 0
  let i = 0
  while (i < s.length && shown < keep) {
    const m = matchSgrAt(s, i)
    if (m) {
      out += m
      i += m.length
      continue
    }
    out += s[i]
    shown++
    i++
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
    if (shown === width) {
      chunks.push(cur)
      cur = ''
      shown = 0
    }
    cur += word[i]
    shown++
    i++
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
