/**
 * ANSI-aware text measurement and wrapping for the terminal UI. Colorized strings
 * carry SGR escape sequences (`\x1b[…m`) that occupy zero visible columns, so a
 * naive `.length` over-counts and a naive wrap breaks early / mid-escape. These
 * helpers measure and wrap by *visible* width, leaving the color codes intact.
 */
import { revealControls } from '@shared/visibleText'

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
 * Strip every control character, for text that came from somewhere we don't
 * control (a release note, an MCP server's error) and is about to be written to
 * the terminal.
 *
 * The terminal executes what it's handed. Text from a remote source can carry an
 * OSC 52 to write the user's clipboard, cursor moves that rewrite the transcript
 * above it, or a hyperlink whose visible text lies about its target — all without
 * the user doing anything but reading. `stripAnsi` is not enough: it removes only
 * SGR, and it is for measuring OUR OWN colored output, where the escapes are
 * intentional. This removes C0, DEL, and C1 (the 8-bit CSI/OSC/DCS introducers),
 * keeping tabs out too since a display string has no use for one.
 */
export function stripControlChars(s: string): string {
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  return s.replace(/[\x00-\x1f\x7f-\x9f]/g, '')
}

/**
 * {@link stripControlChars} for text shown over several lines (a reply, a diff, a
 * multi-line command): newlines and tabs stay, so it keeps its shape, and every
 * other control character goes, a carriage return included (one could rewrite the
 * line it follows). Only the control characters are removed, never the printable
 * rest of an escape sequence: "ESC[2K" leaves "[2K" on screen, since removing a
 * whole OSC ("ESC]0;curl x|sh;BEL") would hide the words inside it.
 *
 * The terminal's display sinks use {@link terminalText} instead, which shows each
 * control character as `<U+XXXX>` rather than removing it; this stays for callers
 * that need the text itself without them.
 */
export function stripControlCharsKeepLines(s: string): string {
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  return s.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
}

/**
 * Text Houston didn't write (a reply, reasoning, a command's output, a tool's
 * argument, a server's message, a conversation title), made safe to print: nothing in
 * it can drive the terminal, and nothing is silently dropped either.
 *
 * Colour codes (SGR) are removed, since they are only styling (a command's coloured
 * output) but can also conceal text. Every other control character, the ESC that
 * opens a cursor move, an erase, a title or clipboard write (OSC 0/52) or an
 * answerback query included, is shown as `<U+XXXX>`, so the sequence is inert and
 * the reader can see it was there. A CRLF line ending becomes a plain newline, and a
 * carriage return ending the text is dropped (it is half of a CRLF cut between two
 * stream chunks, and dropping one can only stop it repainting, never hide anything);
 * any other carriage return, the character that repaints a line, is shown.
 *
 * `lines: false` is for one-line slots (a title, a label, a tool row's hint): line
 * breaks and tabs become spaces instead.
 */
export function terminalText(s: string, opts: { lines?: boolean } = {}): string {
  const text = s.replace(/\r$/, '')
  if (opts.lines === false) {
    return revealControls(stripAnsi(text.replace(/[ \t]*\r?\n[ \t]*/g, ' ').replace(/\t/g, ' ')), { keepLines: false })
  }
  return revealControls(stripAnsi(text.replace(/\r\n/g, '\n')))
}

// The escape sequences the output filter recognizes as one unit: a CSI (cursor
// moves, erases, colours: ESC [ params intermediates final) and an OSC terminated by
// BEL or ST (titles, hyperlinks, clipboard, notifications).
const ESCAPE_UNIT = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^\\x07${ESC}]*(?:\\x07|${ESC}\\\\)`, 'g')
const SGR_ONLY = new RegExp(`^${ESC}\\[[0-9;:]*m$`)
// Ending a hyperlink is harmless whoever writes it.
const OSC8_CLOSE = new Set([`${ESC}]8;;${ESC}\\`, `${ESC}]8;;\x07`])

// The exact OSC sequences Houston itself built (osc8Link, osc52Copy), which the output
// filter lets through. Matching the whole sequence means text that copies one can
// only repeat Houston's own link or copy, never aim it elsewhere. Bounded: oldest go first.
const trustedOsc = new Set<string>()
const MAX_TRUSTED_OSC = 512
function trustOsc(seq: string): string {
  trustedOsc.delete(seq)
  trustedOsc.add(seq)
  if (trustedOsc.size > MAX_TRUSTED_OSC) trustedOsc.delete(trustedOsc.values().next().value as string)
  return seq
}

/**
 * The last line of defence before bytes reach the terminal: every write the TUI makes
 * through its output seam passes here, so a string that skipped {@link terminalText}
 * still can't move the cursor, rewrite the lines above, set the title, write the
 * clipboard or query the terminal. Houston's own styling passes untouched: SGR colour
 * codes, plus the hyperlinks and clipboard writes it built itself (see `trustOsc`).
 * Anything else has its control characters shown as `<U+XXXX>`, like
 * {@link terminalText}; newlines and tabs stay, and CRLF becomes a newline.
 */
export function filterTerminalOutput(s: string): string {
  // eslint-disable-next-line no-control-regex -- the fast path: nothing to filter
  if (!/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(s)) return s
  let out = ''
  let last = 0
  const plain = (t: string): string => revealControls(t.replace(/\r\n/g, '\n'))
  for (const m of s.matchAll(ESCAPE_UNIT)) {
    const seq = m[0]
    out += plain(s.slice(last, m.index))
    out += SGR_ONLY.test(seq) || OSC8_CLOSE.has(seq) || trustedOsc.has(seq) ? seq : revealControls(seq)
    last = m.index + seq.length
  }
  return out + plain(s.slice(last))
}

/**
 * The OSC 52 sequence that asks the terminal to put `text` on the system
 * clipboard. Only for text WE chose to copy (e.g. `/share`'s fixed invite); this
 * is exactly the escape `stripControlChars` keeps out of untrusted output, and the
 * output filter lets this exact sequence through because Houston built it.
 */
export function osc52Copy(text: string): string {
  return trustOsc(`\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`)
}

/**
 * Display columns a single code point occupies: 0 for combining/zero-width marks,
 * 2 for East-Asian wide + fullwidth glyphs and astral emoji, 1 otherwise. A
 * pragmatic wcwidth (not exhaustive) so CJK / emoji don't miscount and overflow
 * the status line, and so truncation never lands mid-wide-char. `.length` counted
 * these as 1 (or, for astral chars, as 2 code units), which was wrong both ways.
 */
export function charWidth(cp: number): number {
  if (
    (cp >= 0x0300 && cp <= 0x036f) || // combining diacritics
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) || // combining marks for symbols (keycap U+20E3)
    (cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    cp === 0x200b ||
    (cp >= 0x200c && cp <= 0x200f) || // ZWNJ, ZWJ, direction marks
    cp === 0xfeff
  ) {
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

// Made on first use: building one loads the break data (about 9 ms), and common text
// is measured without it (see SINGLE_WIDTH).
let graphemeSegmenter: Intl.Segmenter | undefined
const segmenter = (): Intl.Segmenter =>
  (graphemeSegmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' }))

/**
 * The user-perceived characters of `s` (grapheme clusters): a family emoji joined with
 * ZWJs, a flag's two regional indicators, a skin-toned or keycap emoji, or a letter
 * with its combining accents is ONE cluster, drawn as one glyph.
 */
export function graphemes(s: string): string[] {
  const out: string[] = []
  for (const { segment } of segmenter().segment(s)) out.push(segment)
  return out
}

/**
 * Columns one grapheme cluster occupies. Summing its code points over-counted every
 * multi-code-point emoji (a ZWJ family of three people measured 6 columns, a flag 4, a
 * keycap 3, while terminals draw each in 2), which pushed the status line and wrapped
 * text off by the difference. A cluster is as wide as its first code point, except that
 * an emoji-presentation sequence (VS16, a ZWJ join, a keycap) is drawn 2 wide and a
 * text-presentation one (VS15) 1 wide.
 */
export function clusterWidth(cluster: string): number {
  const first = cluster.codePointAt(0) ?? 0
  if (cluster.length <= 2 && String.fromCodePoint(first).length === cluster.length) return charWidth(first)
  if (cluster.includes('\ufe0e')) return Math.min(1, charWidth(first))
  if (cluster.includes('\ufe0f') || cluster.includes('\u200d') || cluster.includes('\u20e3')) return 2
  return charWidth(first)
}

/**
 * Text whose width is its length, the common case: every code point in it is a grapheme
 * cluster of its own, one column wide. That holds for printable ASCII and these BMP
 * blocks: Latin-1 and Latin Extended, IPA and spacing modifiers, Greek, Cyrillic (not
 * its combining marks), general punctuation (dashes, curly quotes, bullets, ellipsis;
 * not the zero-width and direction controls), super- and subscripts, currency, and
 * U+2100-U+2BFF (letterlike, arrows, math, technical, box drawing, blocks, shapes,
 * symbols, dingbats, braille). None holds a combining mark, joiner, variation selector,
 * prepended mark or Hangul jamo (which join their neighbours), a surrogate, or a wide
 * character. Anything else is measured cluster by cluster.
 */
const SINGLE_WIDTH =
  /^[\x20-\x7e\u{a0}-\u{2ff}\u{370}-\u{482}\u{48a}-\u{52f}\u{2010}-\u{2027}\u{2030}-\u{205e}\u{2070}-\u{20cf}\u{2100}-\u{2bff}]*$/u

/** Visible column width of a string, by grapheme cluster, ignoring SGR escapes. */
export function visibleWidth(s: string): number {
  return plainWidth(stripAnsi(s))
}

/** Visible column width of text with no escapes in it. */
function plainWidth(text: string): number {
  if (SINGLE_WIDTH.test(text)) return text.length
  let w = 0
  for (const g of graphemes(text)) w += clusterWidth(g)
  return w
}

/**
 * Whether the space between `left` and `right` (visible text) is part of a larger
 * grapheme cluster, so `left + ' ' + right` is not as wide as its parts: a combining
 * mark, joiner or spacing mark at the start of `right` attaches to the space, and so
 * does a space after a prepended mark at the end of `left`. Only the code points next
 * to the space decide it.
 */
function spaceJoins(left: string, right: string): boolean {
  const before = left.slice(-2)
  const after = right.slice(0, 2)
  if (SINGLE_WIDTH.test(before) && SINGLE_WIDTH.test(after)) return false
  for (const { segment, index } of segmenter().segment(`${before} ${after}`)) {
    if (index + segment.length > before.length) return index !== before.length || segment !== ' '
  }
  return false
}

/**
 * `s` as a sequence of SGR escapes (width 0) and grapheme clusters, so a cut or a
 * wrap never lands inside a cluster: splitting one draws half an emoji, or a flag as
 * two letters.
 */
function units(s: string): Array<{ text: string; width: number }> {
  const out: Array<{ text: string; width: number }> = []
  let last = 0
  for (const m of s.matchAll(SGR)) {
    for (const g of graphemes(s.slice(last, m.index))) out.push({ text: g, width: clusterWidth(g) })
    out.push({ text: m[0], width: 0 })
    last = m.index + m[0].length
  }
  for (const g of graphemes(s.slice(last))) out.push({ text: g, width: clusterWidth(g) })
  return out
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
  for (const u of units(s)) {
    if (shown + u.width > keep) break // stop before a partial/over-width cluster
    out += u.text
    shown += u.width
  }
  const hadColor = out.includes(`${ESC}[`)
  return `${out}${ellipsis}${hadColor ? `${ESC}[0m` : ''}`
}

/**
 * Keep the last `max` visible columns of `s`, with `ellipsis` in front when cut: for
 * text whose end is what matters, like a draft being typed (the cursor is at its end).
 * Plain text only; an SGR escape would be cut like any other character.
 */
export function truncateVisibleStart(s: string, max: number, ellipsis = '…'): string {
  if (visibleWidth(s) <= max) return s
  const keep = Math.max(0, max - visibleWidth(ellipsis))
  const clusters = graphemes(s)
  let out = ''
  let shown = 0
  for (let i = clusters.length - 1; i >= 0; i--) {
    const w = clusterWidth(clusters[i])
    if (shown + w > keep) break
    out = clusters[i] + out
    shown += w
  }
  return `${ellipsis}${out}`
}

/**
 * The first row of `line` at `width` columns, cut at the last space that fits (or at
 * the width, for a word longer than the row), and what follows it. Null when the line
 * already fits. Plain text only.
 */
function cutRow(line: string, width: number): [string, string] | null {
  if (visibleWidth(line) <= width) return null
  let shown = 0
  let at = 0
  let space = -1
  for (const g of graphemes(line)) {
    const w = clusterWidth(g)
    if (shown + w > width) break
    if (g === ' ') space = at
    shown += w
    at += g.length
  }
  if (space > 0) return [line.slice(0, space), line.slice(space + 1)]
  // Always take something, even a cluster wider than the row, so the caller advances.
  if (at === 0) at = graphemes(line)[0]?.length ?? line.length
  return [line.slice(0, at), line.slice(at)]
}

/**
 * Split text that is still streaming into the rows ready to print and the unfinished
 * tail to hold back: every complete line, word-wrapped to `width`, plus whatever full
 * rows the tail already fills. Every ready row ends in a newline, so the next write
 * (a spinner frame, the reply) starts at the left edge instead of on a half-written
 * line. Plain text only; `width` <= 0 leaves lines unwrapped.
 */
export function takeStreamedRows(buf: string, width: number): { rows: string; rest: string } {
  const lines = buf.split('\n')
  let rest = lines.pop() ?? ''
  const out: string[] = []
  const wrapInto = (line: string): string => {
    let left = line
    for (let cut = width > 0 ? cutRow(left, width) : null; cut; cut = cutRow(left, width)) {
      out.push(cut[0])
      left = cut[1]
    }
    return left
  }
  for (const line of lines) out.push(wrapInto(line))
  rest = wrapInto(rest)
  return { rows: out.length ? `${out.join('\n')}\n` : '', rest }
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
  // Each word is measured once and the row's width kept as a sum: measuring the whole
  // growing row again for every word made long non-ASCII paragraphs slow to wrap. The
  // row's visible text is kept for the rare join a sum can't measure (spaceJoins).
  let curWidth = 0
  let curText = ''
  const push = (): void => {
    if (cur) out.push(cur)
    cur = ''
  }
  for (const word of words) {
    const text = stripAnsi(word)
    const wordWidth = plainWidth(text)
    if (wordWidth > width) {
      // A single word longer than the line — hard-split it.
      push()
      for (const chunk of hardSplit(word, width)) out.push(chunk)
      continue
    }
    const candidate = cur ? `${cur} ${word}` : word
    const candidateText = cur ? `${curText} ${text}` : text
    const candidateWidth = !cur
      ? wordWidth
      : spaceJoins(curText, text)
        ? plainWidth(candidateText)
        : curWidth + 1 + wordWidth
    if (candidateWidth > width) {
      push()
      cur = word
      curText = text
      curWidth = wordWidth
    } else {
      cur = candidate
      curText = candidateText
      curWidth = candidateWidth
    }
  }
  push()
  return out.join('\n')
}

function hardSplit(word: string, width: number): string[] {
  const chunks: string[] = []
  let cur = ''
  let shown = 0
  for (const u of units(word)) {
    // Break before a cluster that would overflow the row (only if we've placed one).
    if (cur && u.width > 0 && shown + u.width > width) {
      chunks.push(cur)
      cur = ''
      shown = 0
    }
    cur += u.text
    shown += u.width
  }
  if (cur) chunks.push(cur)
  return chunks
}

/**
 * An OSC 8 hyperlink: `text` shown, `url` opened on a click (cmd/ctrl-click in most
 * terminals; ones without OSC 8 just show the text). Only for links WE build to a
 * known target, like osc52Copy; `text` and `url` must already be free of control
 * characters, or a crafted label could end the link early and inject its own.
 */
export function osc8Link(url: string, text: string): string {
  return `${trustOsc(`\x1b]8;;${url}\x1b\\`)}${text}\x1b]8;;\x1b\\`
}
