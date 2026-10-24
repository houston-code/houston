import { stripAnsi } from './ansi.mjs'

/**
 * Display width in terminal columns.
 *
 * A character here is what the user sees as one character: a grapheme cluster, as
 * Intl.Segmenter splits text. Its width is 2 when it holds a wide code point (the WIDE
 * ranges: CJK, Hangul, kana, fullwidth forms, emoji) or is a flag (a pair of regional
 * indicators); 0 when every code point in it is zero-width (combining marks, joiners,
 * variation selectors); 1 otherwise. So 👩‍💻, 👍🏽 and 🇯🇵 are each one character two
 * columns wide, and an é written as e + U+0301 is one character one column wide.
 */
export const WIDE = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x3fffd]
]

const ZERO_WIDTH = /^[\p{Mn}\p{Me}​-‏︀-️]$/u

export function isWide(cp) {
  return WIDE.some(([lo, hi]) => cp >= lo && cp <= hi)
}

export function codePointWidth(cp) {
  if (ZERO_WIDTH.test(String.fromCodePoint(cp))) return 0
  return isWide(cp) ? 2 : 1
}

/** Columns `text` takes on screen. Color codes take none. */
export function stringWidth(text) {
  let width = 0
  for (const ch of stripAnsi(text)) width += codePointWidth(ch.codePointAt(0))
  return width
}
