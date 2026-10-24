import { callTool, say, turn, type EvalTask } from '../../types'

// The reference fix, kept as lines so a fixture change diffs like code.
const WIDTH = [
  'import { stripAnsi } from \'./ansi.mjs\'',
  '',
  '/**',
  ' * Display width in terminal columns.',
  ' *',
  ' * A character here is what the user sees as one character: a grapheme cluster, as',
  ' * Intl.Segmenter splits text. Its width is 2 when it holds a wide code point (the WIDE',
  ' * ranges: CJK, Hangul, kana, fullwidth forms, emoji) or is a flag (a pair of regional',
  ' * indicators); 0 when every code point in it is zero-width (combining marks, joiners,',
  ' * variation selectors); 1 otherwise. So 👩‍💻, 👍🏽 and 🇯🇵 are each one character two',
  ' * columns wide, and an é written as e + U+0301 is one character one column wide.',
  ' */',
  'export const WIDE = [',
  '  [0x1100, 0x115f],',
  '  [0x2e80, 0x303e],',
  '  [0x3041, 0x33ff],',
  '  [0x3400, 0x4dbf],',
  '  [0x4e00, 0x9fff],',
  '  [0xa960, 0xa97f],',
  '  [0xac00, 0xd7a3],',
  '  [0xf900, 0xfaff],',
  '  [0xfe30, 0xfe4f],',
  '  [0xff00, 0xff60],',
  '  [0xffe0, 0xffe6],',
  '  [0x1f300, 0x1f64f],',
  '  [0x1f680, 0x1f6ff],',
  '  [0x1f900, 0x1f9ff],',
  '  [0x1fa70, 0x1faff],',
  '  [0x20000, 0x3fffd]',
  ']',
  '',
  'const ZERO_WIDTH = /^[\\p{Mn}\\p{Me}​-‏︀-️]$/u',
  '',
  'export function isWide(cp) {',
  '  return WIDE.some(([lo, hi]) => cp >= lo && cp <= hi)',
  '}',
  '',
  'export function codePointWidth(cp) {',
  '  if (ZERO_WIDTH.test(String.fromCodePoint(cp))) return 0',
  '  return isWide(cp) ? 2 : 1',
  '}',
  '',
  'const segmenter = new Intl.Segmenter(\'en\', { granularity: \'grapheme\' })',
  'const REGIONAL_INDICATOR = /\\p{Regional_Indicator}/u',
  '',
  '/** Columns one grapheme cluster takes: 2 if it holds a wide code point or is a flag, 0 if all of it is zero-width, else 1. */',
  'export function clusterWidth(cluster) {',
  '  let zero = true',
  '  let indicators = 0',
  '  for (const ch of cluster) {',
  '    const cp = ch.codePointAt(0)',
  '    if (isWide(cp)) return 2',
  '    if (REGIONAL_INDICATOR.test(ch)) indicators++',
  '    if (codePointWidth(cp) !== 0) zero = false',
  '  }',
  '  if (indicators >= 2) return 2',
  '  return zero ? 0 : 1',
  '}',
  '',
  '/** The grapheme clusters of `text`, in order. */',
  'export function clusters(text) {',
  '  return Array.from(segmenter.segment(text), (s) => s.segment)',
  '}',
  '',
  '/** Columns `text` takes on screen. Color codes take none. */',
  'export function stringWidth(text) {',
  '  return clusters(stripAnsi(text)).reduce((n, c) => n + clusterWidth(c), 0)',
  '}',
  ''
].join('\n')

const WRAP = [
  'import { ANSI } from \'./ansi.mjs\'',
  'import { clusters, clusterWidth } from \'./width.mjs\'',
  '',
  '/**',
  ' * Wrap text to lines at most `width` columns wide (width.mjs says what a column is).',
  ' *',
  ' * Lines break at spaces where they can. A word wider than a whole line is broken',
  ' * between characters, never inside one, so a flag or 👩‍💻 is never cut in half. Color',
  ' * codes take no columns and are never cut either. Wrapped lines carry no leading or',
  ' * trailing spaces, and newlines in the text are kept as line breaks.',
  ' */',
  'export function wrap(text, width) {',
  '  const out = []',
  '  for (const paragraph of text.split(\'\\n\')) {',
  '    let line = \'\'',
  '    let lineWidth = 0',
  '    for (const word of paragraph.split(\' \').filter(Boolean)) {',
  '      const pieces = units(word)',
  '      const wordWidth = pieces.reduce((n, u) => n + u.width, 0)',
  '      if (line && lineWidth + 1 + wordWidth <= width) {',
  '        line += ` ${word}`',
  '        lineWidth += 1 + wordWidth',
  '        continue',
  '      }',
  '      if (line) out.push(line)',
  '      line = \'\'',
  '      lineWidth = 0',
  '      // A word that fits on a line of its own starts one; a wider one is broken',
  '      // between characters, filling each line.',
  '      for (const u of pieces) {',
  '        if (lineWidth + u.width > width) {',
  '          out.push(line)',
  '          line = \'\'',
  '          lineWidth = 0',
  '        }',
  '        line += u.text',
  '        lineWidth += u.width',
  '      }',
  '    }',
  '    out.push(line)',
  '  }',
  '  return out',
  '}',
  '',
  '/** A word as color codes (no width) and grapheme clusters, each kept whole. */',
  'function units(word) {',
  '  const out = []',
  '  let last = 0',
  '  for (const m of word.matchAll(ANSI)) {',
  '    for (const c of clusters(word.slice(last, m.index))) out.push({ text: c, width: clusterWidth(c) })',
  '    out.push({ text: m[0], width: 0 })',
  '    last = m.index + m[0].length',
  '  }',
  '  for (const c of clusters(word.slice(last))) out.push({ text: c, width: clusterWidth(c) })',
  '  return out',
  '}',
  ''
].join('\n')

/**
 * From Houston's own TUI fix (#354, width and wrapping by grapheme cluster). The box
 * the agent's output is drawn in measures text by code unit (`.length`), so CJK runs
 * past the border, and `stringWidth` adds up code points, so 👩‍💻 counts as four
 * columns. The visible test is the reported overflow, in Japanese. The holdout checks
 * the contract width.mjs and wrap.mjs state: emoji sequences, flags and combining marks
 * are one character each, a word is never broken inside one, color codes take no width
 * and are never cut, across 2000 seeded random texts and widths. Fixing the CJK case
 * with `stringWidth` instead of `.length` passes the visible test and fails the rest.
 */
export const task: EvalTask = {
  id: 'terminal-wrap-width',
  title: 'Wrap terminal text by display width, one character at a time',
  prompt:
    "Text in our terminal UI's boxes runs past the right border when it's Japanese (and, users say, when it has emoji in it). `node test.mjs` reproduces the Japanese case. Fix the wrapping. test.mjs is the spec, so do not change it.",
  verify: { cmd: 'node', args: ['test.mjs'] },
  // What width.mjs and wrap.mjs promise for every kind of character, fuzzed.
  holdout: { cmd: 'node', args: ['hidden.test.mjs'] },
  script: [
    turn(callTool('c1', 'run_shell', { command: 'node test.mjs' })),
    turn(
      callTool('c2', 'read_file', { path: 'ui/box.mjs' }),
      callTool('c3', 'read_file', { path: 'text/wrap.mjs' }),
      callTool('c4', 'read_file', { path: 'text/width.mjs' })
    ),
    turn(
      callTool('c5', 'write_file', { path: 'text/width.mjs', content: WIDTH }),
      callTool('c6', 'write_file', { path: 'text/wrap.mjs', content: WRAP })
    ),
    turn(callTool('c7', 'run_shell', { command: 'node test.mjs' })),
    turn(
      say(
        "Two causes. `wrap` measured and cut text by UTF-16 code unit, so a CJK character counted as one column and a long word could be cut through an emoji. `stringWidth` added up code points, so 👩‍💻 or 👍🏽 counted as four columns. Both now work in grapheme clusters (Intl.Segmenter): a cluster is two columns if it holds a wide code point or is a flag, zero if it is all combining marks or joiners, and a long word breaks only between clusters, with color codes kept whole and zero width. `node test.mjs` prints ok."
      )
    )
  ]
}
