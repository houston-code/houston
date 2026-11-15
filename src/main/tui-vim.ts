import {
  reduceEditor,
  editorEmpty,
  insertText,
  cps,
  cpLen,
  cpSlice,
  type EditorState,
  type EditorOutcome
} from './tui-editor'
import type { EditorKey } from './tui-keys'
import type { Painter } from './tui'

/**
 * Vim keys for the composer.
 *
 * A modal layer OVER the editor rather than a second editor: insert mode hands
 * every key to `reduceEditor` untouched, and normal mode does its buffer surgery
 * on the same `EditorState`. So pastes, blob collapsing, history, kill/yank and
 * the view keep working exactly as they do without vim, and there is no second
 * implementation of "what is a line" to drift.
 *
 * Off by default; `/vim` turns it on and remembers the choice.
 *
 * What it covers: modes (i a I A o O s / Esc), motions (h j k l w W b B e E 0 ^ $
 * gg G, f F t T with ; and , to repeat them, % to the matching bracket) with
 * counts, operators d c y > < over any of those motions or a text object (iw aw iW
 * aW, i" a" i' a', i( a( i[ a[ i{ a{) plus the doubled forms (dd cc yy >> <<),
 * x X D C, r, p P, u, `.` to repeat the last change, and visual (v) and
 * visual-line (V) modes with d x y c s > < over the selection. That is the
 * muscle-memory core. What it deliberately does NOT try to be is vim: no registers
 * beyond the unnamed one, no marks, no macros, no `:` commands, no search motions
 * (`/`, `n`), no blockwise visual mode. A composer is a message box, and each of
 * those wants a real vim underneath.
 */

export type VimMode = 'insert' | 'normal' | 'visual' | 'visual-line'

/** A buffer snapshot for `u`. */
interface Snapshot {
  lines: string[]
  row: number
  col: number
}

interface Pos {
  row: number
  col: number
}

/** The last f/F/t/T, for `;` and `,`. */
export interface FindSpec {
  cmd: 'f' | 'F' | 't' | 'T'
  ch: string
}

/**
 * What `.` replays. A normal-mode command is kept as the keys that made it, plus
 * the text typed afterwards when it entered insert mode (`cw` then "foo"); a visual
 * change as its operator and the size of the selection it covered, which is how
 * vim repeats one: the same amount of text, from where the cursor is now.
 */
export type LastChange =
  | { kind: 'keys'; keys: string; text: string | null }
  | { kind: 'visual'; op: string; linewise: boolean; size: number; text: string | null }

export interface VimState {
  mode: VimMode
  /**
   * Normal-mode keys typed so far that do not yet mean anything: count digits, a
   * pending operator (`d`), `g` waiting for its second `g`, `r` waiting for its
   * replacement. Held as raw text because that is what it is — an unfinished command.
   */
  pending: string
  /** The unnamed register: what `d`/`x`/`y` took and `p` puts back. */
  register: string
  /** Whether the register holds whole lines (dd/yy), which `p` puts on their own lines. */
  registerLinewise: boolean
  /** Snapshots for `u`, oldest first. Bounded: a composer is not a file. */
  undo: Snapshot[]
  /** Where a visual selection started; the cursor is its other end. Null outside visual modes. */
  anchor: Pos | null
  /** The last f/F/t/T, which `;` repeats and `,` repeats backwards. */
  lastFind: FindSpec | null
  /** The last change, for `.`. */
  lastChange: LastChange | null
  /**
   * The change being made while insert mode is open, collecting what is typed so
   * Esc can store it as `lastChange`. Null when the insert session can't be
   * repeated faithfully (the cursor was moved with an arrow, say).
   */
  recording: LastChange | null
}

/** Deepest undo stack we keep. A draft is short; this is already generous. */
const UNDO_LIMIT = 100

/**
 * Largest count a command will act on.
 *
 * Counts are typed, so this looks self-inflicted — but a terminal without
 * bracketed paste delivers a paste as ordinary keystrokes, and in normal mode
 * those are commands. Pasting something with a long digit run then reaching `p`
 * would ask for a register repeated billions of times, or a word motion stepped
 * billions of times: an out-of-memory or a hung composer, from a paste. Real vim
 * caps counts as well.
 */
const COUNT_LIMIT = 10_000

/** Longest half-typed command held. Bounds `pending` against the same paste. */
const PENDING_LIMIT = 16

/** Longest insert recorded for `.`; past it the insert is not repeatable. */
const RECORD_LIMIT = 10_000

/** What `>` puts in front of a line and `<` takes away. */
const INDENT = '  '

export function initialVimState(): VimState {
  return {
    mode: 'insert',
    pending: '',
    register: '',
    registerLinewise: false,
    undo: [],
    anchor: null,
    lastFind: null,
    lastChange: null,
    recording: null
  }
}

/**
 * Cursor-shape signals (DECSCUSR). Normal mode gets a block, insert a bar — the
 * signal every vim user already reads without looking. A terminal that does not
 * implement it ignores the sequence, so this cannot corrupt the display.
 */
export const CURSOR_BLOCK = '\x1b[2 q'
export const CURSOR_BAR = '\x1b[6 q'
/** Hand the cursor back to whatever the terminal's own default is. */
export const CURSOR_RESET = '\x1b[0 q'

/** The cursor shape for a mode: a bar to type, a block for every command mode. */
export function vimCursor(mode: VimMode): string {
  return mode === 'insert' ? CURSOR_BAR : CURSOR_BLOCK
}

/** The mode marker shown in front of the prompt. */
export function vimStatus(mode: VimMode, paint: Painter): string {
  switch (mode) {
    case 'normal':
      return `${paint('N', 'cyan')} `
    case 'visual':
      return `${paint('v', 'cyan')} `
    case 'visual-line':
      return `${paint('V', 'cyan')} `
    default:
      return `${paint('I', 'dim')} `
  }
}

type CharClass = 'blank' | 'word' | 'punct'

/**
 * Vim's three character classes. `w` stops at a word/punctuation boundary and `W`
 * only at whitespace, which is the whole difference between them.
 */
function classOf(ch: string): CharClass {
  if (/\s/.test(ch)) return 'blank'
  return /[\p{L}\p{N}_]/u.test(ch) ? 'word' : 'punct'
}

/**
 * The buffer as one flat run of code points, line breaks included.
 *
 * Word motions cross lines, and a line break is just another blank to them; doing
 * this on a flat view is what keeps `w` from needing to know about rows at all.
 */
function flatten(s: EditorState): string[] {
  return cps(s.lines.join('\n'))
}

function flatIndex(s: EditorState, p: Pos = s): number {
  let i = 0
  for (let r = 0; r < p.row; r++) i += cpLen(s.lines[r] ?? '') + 1
  return i + p.col
}

function posFromFlat(lines: string[], index: number): Pos {
  let rem = Math.max(0, index)
  for (let r = 0; r < lines.length; r++) {
    const len = cpLen(lines[r])
    if (rem <= len) return { row: r, col: rem }
    rem -= len + 1
  }
  const last = lines.length - 1
  return { row: last, col: cpLen(lines[last] ?? '') }
}

/** Start of the next word (`w`/`W`). */
function fwdWord(c: string[], i: number, big: boolean): number {
  const n = c.length
  if (i >= n) return n
  const cls = classOf(c[i])
  let j = i
  if (cls !== 'blank') {
    while (j < n && classOf(c[j]) !== 'blank' && (big || classOf(c[j]) === cls)) j++
  }
  while (j < n && classOf(c[j]) === 'blank') j++
  return j
}

/** Start of the previous word (`b`/`B`). */
function backWord(c: string[], i: number, big: boolean): number {
  let j = i - 1
  while (j >= 0 && classOf(c[j]) === 'blank') j--
  if (j < 0) return 0
  const cls = classOf(c[j])
  while (j >= 0 && classOf(c[j]) !== 'blank' && (big || classOf(c[j]) === cls)) j--
  return j + 1
}

/** End of the current/next word (`e`/`E`) — inclusive, as vim counts it. */
function endWord(c: string[], i: number, big: boolean): number {
  const n = c.length
  let j = i + 1
  while (j < n && classOf(c[j]) === 'blank') j++
  if (j >= n) return Math.max(0, n - 1)
  const cls = classOf(c[j])
  while (j + 1 < n && classOf(c[j + 1]) !== 'blank' && (big || classOf(c[j + 1]) === cls)) j++
  return j
}

/** First non-blank of a line (`^`, and where linewise operations leave the cursor). */
function firstNonBlank(line: string): number {
  const c = cps(line)
  let i = 0
  while (i < c.length && /\s/.test(c[i])) i++
  return i === c.length ? Math.max(0, c.length - 1) : i
}

/** The bracket pairs `%` and the bracket text objects know. */
const OPEN_OF: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
const CLOSE_OF: Record<string, string> = { '(': ')', '[': ']', '{': '}' }

/** The flat index of the bracket matching the one at `i`, or -1. Crosses lines. */
function matchBracket(c: string[], i: number): number {
  const ch = c[i]
  const close = CLOSE_OF[ch]
  if (close) {
    let depth = 0
    for (let j = i; j < c.length; j++) {
      if (c[j] === ch) depth++
      else if (c[j] === close && --depth === 0) return j
    }
    return -1
  }
  const open = OPEN_OF[ch]
  if (open) {
    let depth = 0
    for (let j = i; j >= 0; j--) {
      if (c[j] === ch) depth++
      else if (c[j] === open && --depth === 0) return j
    }
  }
  return -1
}

/**
 * Where f/F/t/T land on the line, or null when the character isn't there. `repeat`
 * is a `;`/`,` repeat: a `t` that already sits just before its character would not
 * move, so a repeat looks one further, as vim does.
 */
function findInLine(line: string, col: number, spec: FindSpec, count: number, repeat: boolean): number | null {
  const c = cps(line)
  const forward = spec.cmd === 'f' || spec.cmd === 't'
  const till = spec.cmd === 't' || spec.cmd === 'T'
  let j = col
  if (repeat && till) j += forward ? 1 : -1
  for (let n = 0; n < count; n++) {
    j += forward ? 1 : -1
    while (j >= 0 && j < c.length && c[j] !== spec.ch) j += forward ? 1 : -1
    if (j < 0 || j >= c.length) return null
  }
  return till ? j + (forward ? -1 : 1) : j
}

/**
 * Normal mode's cursor sits ON a character, never past the end of the line —
 * which is exactly where insert mode is allowed to be. Every path back into
 * normal mode goes through here.
 */
function clampNormal(s: EditorState): EditorState {
  const len = cpLen(s.lines[s.row] ?? '')
  const col = Math.min(s.col, Math.max(0, len - 1))
  return col === s.col ? s : { ...s, col }
}

function snapshot(s: EditorState): Snapshot {
  return { lines: [...s.lines], row: s.row, col: s.col }
}

/** Remember the buffer so `u` can bring it back. */
function pushUndo(v: VimState, s: EditorState): Snapshot[] {
  return [...v.undo, snapshot(s)].slice(-UNDO_LIMIT)
}

/** A resolved motion target: where, and how an operator should treat it. */
interface MotionResult {
  pos: Pos
  /** The character under `pos` is part of the range (`e`, `$`, `f`, `%`). */
  inclusive?: boolean
  /** The motion spans whole lines (`j`, `k`, `G`, `gg`). */
  linewise?: boolean
  /** An f/F/t/T that ran: what `;` should repeat from now on. */
  find?: FindSpec
}

/**
 * Resolve a motion key to a target. Returns null when the key isn't a motion (or a
 * find that found nothing), so the caller can tell "not a motion" from "a motion
 * that went nowhere". `arg` is the character an f/F/t/T is looking for.
 */
function motion(
  s: EditorState,
  key: string,
  count: number,
  ctx: { arg?: string; lastFind: FindSpec | null }
): MotionResult | null {
  const line = s.lines[s.row] ?? ''
  const lastRow = s.lines.length - 1

  switch (key) {
    case 'h':
      return { pos: { row: s.row, col: Math.max(0, s.col - count) } }
    case 'l':
      return { pos: { row: s.row, col: Math.min(cpLen(line), s.col + count) } }
    case 'j':
      return { pos: { row: Math.min(lastRow, s.row + count), col: s.col }, linewise: true }
    case 'k':
      return { pos: { row: Math.max(0, s.row - count), col: s.col }, linewise: true }
    case '0':
      return { pos: { row: s.row, col: 0 } }
    case '^':
      return { pos: { row: s.row, col: firstNonBlank(line) } }
    case '$':
      return { pos: { row: s.row, col: Math.max(0, cpLen(line) - 1) }, inclusive: true }
    case 'w':
    case 'W': {
      const c = flatten(s)
      let j = flatIndex(s)
      for (let n = 0; n < count; n++) j = fwdWord(c, j, key === 'W')
      return { pos: posFromFlat(s.lines, j) }
    }
    case 'b':
    case 'B': {
      const c = flatten(s)
      let j = flatIndex(s)
      for (let n = 0; n < count; n++) j = backWord(c, j, key === 'B')
      return { pos: posFromFlat(s.lines, j) }
    }
    case 'e':
    case 'E': {
      const c = flatten(s)
      let j = flatIndex(s)
      for (let n = 0; n < count; n++) j = endWord(c, j, key === 'E')
      return { pos: posFromFlat(s.lines, j), inclusive: true }
    }
    case 'G':
      return { pos: { row: lastRow, col: 0 }, linewise: true }
    case 'gg':
      // `3gg` goes to line 3; a bare `gg` to the first line.
      return { pos: { row: Math.min(lastRow, count - 1), col: 0 }, linewise: true }
    case 'f':
    case 'F':
    case 't':
    case 'T': {
      if (ctx.arg === undefined) return null
      const spec: FindSpec = { cmd: key, ch: ctx.arg }
      const col = findInLine(line, s.col, spec, count, false)
      if (col === null) return null
      return { pos: { row: s.row, col }, inclusive: key === 'f' || key === 't', find: spec }
    }
    case ';':
    case ',': {
      const last = ctx.lastFind
      if (!last) return null
      const flip: Record<FindSpec['cmd'], FindSpec['cmd']> = { f: 'F', F: 'f', t: 'T', T: 't' }
      const spec: FindSpec = key === ';' ? last : { cmd: flip[last.cmd], ch: last.ch }
      const col = findInLine(line, s.col, spec, count, true)
      if (col === null) return null
      return { pos: { row: s.row, col }, inclusive: spec.cmd === 'f' || spec.cmd === 't' }
    }
    case '%': {
      // The bracket under the cursor, or the first one after it on the line.
      const c = flatten(s)
      const lineStart = flatIndex(s, { row: s.row, col: 0 })
      const lineEnd = lineStart + cpLen(line)
      let i = flatIndex(s)
      while (i < lineEnd && !CLOSE_OF[c[i]] && !OPEN_OF[c[i]]) i++
      if (i >= lineEnd) return null
      const j = matchBracket(c, i)
      if (j < 0) return null
      return { pos: posFromFlat(s.lines, j), inclusive: true }
    }
    default:
      return null
  }
}

/** A charwise span [a, b) of the flat buffer, or whole lines r1..r2. */
type Range = { linewise: true; r1: number; r2: number } | { linewise: false; a: number; b: number }

/**
 * A text object (`iw`, `a"`, `i(` …) around the cursor, as a charwise range, or null
 * when there is none here (no quotes on the line, no enclosing bracket).
 */
function textObject(s: EditorState, kind: 'i' | 'a', obj: string): Range | null {
  const around = kind === 'a'
  switch (obj) {
    case 'w':
    case 'W':
      return wordObject(s, obj === 'W', around)
    case '"':
    case "'":
    case '`':
      return quoteObject(s, obj, around)
    case '(':
    case ')':
    case 'b':
      return bracketObject(s, '(', around)
    case '[':
    case ']':
      return bracketObject(s, '[', around)
    case '{':
    case '}':
    case 'B':
      return bracketObject(s, '{', around)
    default:
      return null
  }
}

function wordObject(s: EditorState, big: boolean, around: boolean): Range | null {
  const c = cps(s.lines[s.row] ?? '')
  if (!c.length) return null
  const at = Math.min(s.col, c.length - 1)
  const kind = (ch: string): string => (big ? (classOf(ch) === 'blank' ? 'blank' : 'word') : classOf(ch))
  const cls = kind(c[at])
  let l = at
  let r = at + 1
  while (l > 0 && kind(c[l - 1]) === cls) l--
  while (r < c.length && kind(c[r]) === cls) r++
  if (around) {
    if (cls === 'blank') {
      // On a gap, "a word" is the gap and the word after it.
      if (r < c.length) {
        const next = kind(c[r])
        while (r < c.length && kind(c[r]) === next) r++
      }
    } else {
      let r2 = r
      while (r2 < c.length && classOf(c[r2]) === 'blank') r2++
      if (r2 > r) r = r2
      else while (l > 0 && classOf(c[l - 1]) === 'blank') l--
    }
  }
  const base = flatIndex(s, { row: s.row, col: 0 })
  return { linewise: false, a: base + l, b: base + r }
}

function quoteObject(s: EditorState, q: string, around: boolean): Range | null {
  const c = cps(s.lines[s.row] ?? '')
  const quotes: number[] = []
  for (let i = 0; i < c.length; i++) if (c[i] === q && c[i - 1] !== '\\') quotes.push(i)
  let pair: [number, number] | null = null
  for (let i = 0; i + 1 < quotes.length; i += 2) {
    const [l, r] = [quotes[i], quotes[i + 1]]
    if (l <= s.col && s.col <= r) {
      pair = [l, r]
      break
    }
    // Before any pair that holds the cursor: the next pair on the line, as in vim.
    if (l > s.col && !pair) {
      pair = [l, r]
      break
    }
  }
  if (!pair) return null
  let [l, r] = [pair[0], pair[1] + 1]
  if (!around) {
    l += 1
    r -= 1
  } else {
    let r2 = r
    while (r2 < c.length && /\s/.test(c[r2])) r2++
    if (r2 > r) r = r2
    else while (l > 0 && /\s/.test(c[l - 1])) l--
  }
  const base = flatIndex(s, { row: s.row, col: 0 })
  return { linewise: false, a: base + l, b: base + r }
}

function bracketObject(s: EditorState, open: string, around: boolean): Range | null {
  const close = CLOSE_OF[open]
  const c = flatten(s)
  const i = flatIndex(s)
  let l = -1
  if (c[i] === open) l = i
  else if (c[i] === close) l = matchBracket(c, i)
  else {
    let depth = 0
    for (let j = i - 1; j >= 0; j--) {
      if (c[j] === close) depth++
      else if (c[j] === open) {
        if (depth === 0) {
          l = j
          break
        }
        depth--
      }
    }
  }
  if (l < 0) return null
  const r = matchBracket(c, l)
  if (r < 0) return null
  return around ? { linewise: false, a: l, b: r + 1 } : { linewise: false, a: l + 1, b: r }
}

/** Cut a charwise span [a, b) out of the buffer, returning the text and the new state. */
function cutFlat(s: EditorState, a: number, b: number): { state: EditorState; text: string } {
  const c = flatten(s)
  const lo = Math.max(0, Math.min(a, b))
  const hi = Math.min(c.length, Math.max(a, b))
  const text = c.slice(lo, hi).join('')
  const lines = [...c.slice(0, lo), ...c.slice(hi)].join('').split('\n')
  const pos = posFromFlat(lines, lo)
  return { state: { ...s, lines, row: pos.row, col: pos.col }, text }
}

/** Cut whole lines r1..r2 (inclusive). */
function cutLines(s: EditorState, r1: number, r2: number): { state: EditorState; text: string } {
  const lo = Math.max(0, Math.min(r1, r2))
  const hi = Math.min(s.lines.length - 1, Math.max(r1, r2))
  const lines = [...s.lines]
  const removed = lines.splice(lo, hi - lo + 1)
  if (!lines.length) lines.push('')
  const row = Math.min(lo, lines.length - 1)
  return {
    state: { ...s, lines, row, col: firstNonBlank(lines[row]) },
    // The trailing newline is what makes this register linewise on the way back out.
    text: `${removed.join('\n')}\n`
  }
}

/** The span an operator covers, given where the motion landed. */
function operatorRange(s: EditorState, m: MotionResult): Range {
  if (m.linewise) return { linewise: true, r1: Math.min(s.row, m.pos.row), r2: Math.max(s.row, m.pos.row) }
  const a = flatIndex(s)
  const b = flatIndex(s, m.pos) + (m.inclusive ? 1 : 0)
  return { linewise: false, a: Math.min(a, b), b: Math.max(a, b) }
}

/** The rows a range touches (what `>` and `<` shift). */
function rowsOf(s: EditorState, range: Range): [number, number] {
  if (range.linewise) return [range.r1, range.r2]
  const a = posFromFlat(s.lines, range.a)
  const b = posFromFlat(s.lines, Math.max(range.a, range.b - 1))
  return [a.row, b.row]
}

interface VimResult {
  vim: VimState
  state: EditorState
  outcome?: EditorOutcome
}

/**
 * Apply operator `op` (d c y > <) over `range`. `times` repeats a shift (`3>>` is one
 * line shifted once; `v3>` is the selection shifted three times, as in vim).
 */
function applyOperator(
  vim: VimState,
  s: EditorState,
  op: string,
  range: Range,
  opts: { times?: number; cursorToStart?: boolean } = {}
): VimResult {
  const base: VimState = { ...vim, pending: '', mode: 'normal', anchor: null }
  if (op === 'y') {
    if (range.linewise) {
      const text = `${s.lines.slice(range.r1, range.r2 + 1).join('\n')}\n`
      const state = opts.cursorToStart ? { ...s, row: range.r1, col: Math.min(s.col, cpLen(s.lines[range.r1])) } : s
      return { vim: { ...base, register: text, registerLinewise: true }, state: clampNormal(state) }
    }
    const text = flatten(s).slice(range.a, range.b).join('')
    // Yank leaves the cursor at the start of what it took.
    const pos = posFromFlat(s.lines, range.a)
    return {
      vim: { ...base, register: text, registerLinewise: false },
      state: clampNormal({ ...s, row: pos.row, col: pos.col })
    }
  }
  if (op === '>' || op === '<') {
    const [r1, r2] = rowsOf(s, range)
    const times = Math.min(COUNT_LIMIT, Math.max(1, opts.times ?? 1))
    const lines = [...s.lines]
    for (let r = r1; r <= r2; r++) {
      let line = lines[r]
      for (let n = 0; n < times; n++) {
        if (op === '>') {
          // An empty line stays empty: indenting nothing only leaves trailing spaces.
          if (line.length) line = INDENT + line
        } else if (line.startsWith(INDENT)) line = line.slice(INDENT.length)
        else if (line.startsWith('\t') || line.startsWith(' ')) line = line.slice(1)
      }
      lines[r] = line
    }
    if (lines.every((l, i) => l === s.lines[i])) return { vim: base, state: clampNormal(s) }
    return {
      vim: { ...base, undo: pushUndo(vim, s) },
      state: clampNormal({ ...s, lines, row: r1, col: firstNonBlank(lines[r1]) })
    }
  }
  const undo = pushUndo(vim, s)
  if (op === 'c') {
    if (range.linewise) {
      // `cc` and `cj` keep a line to type on; `dd` takes the lines away.
      const cut = cutLines(s, range.r1, range.r2)
      const lines = [...s.lines]
      lines.splice(range.r1, range.r2 - range.r1 + 1, '')
      return {
        vim: { ...base, mode: 'insert', register: cut.text, registerLinewise: true, undo },
        state: { ...s, lines, row: range.r1, col: 0 }
      }
    }
    const cut = cutFlat(s, range.a, range.b)
    return {
      vim: { ...base, mode: 'insert', register: cut.text, registerLinewise: false, undo },
      state: cut.state
    }
  }
  const cut = range.linewise ? cutLines(s, range.r1, range.r2) : cutFlat(s, range.a, range.b)
  return {
    vim: { ...base, register: cut.text, registerLinewise: range.linewise, undo },
    state: clampNormal(cut.state)
  }
}

/** Parse the count digits in front of a command; 0 when there are none. */
const num = (d: string | undefined): number => (d ? Number.parseInt(d, 10) : 0)
const product = (a: number, b: number): number => Math.min(COUNT_LIMIT, Math.max(1, a || 1) * Math.max(1, b || 1))

/**
 * Apply one normal-mode character. `pending` carries whatever came before it that
 * did not yet form a command.
 */
function normalChar(vim: VimState, s: EditorState, ch: string): VimResult {
  const pending = vim.pending + ch
  // A command this long is not one someone is typing; drop it rather than let it grow.
  if (pending.length > PENDING_LIMIT) return { vim: { ...vim, pending: '' }, state: s }
  const keep = (p: string): VimResult => ({ vim: { ...vim, pending: p }, state: s })
  const clear = (state: EditorState, over: Partial<VimState> = {}): VimResult => ({
    vim: { ...vim, pending: '', ...over },
    state: clampNormal(state)
  })

  // `r<char>`: replace the character under the cursor. Takes the next key whatever
  // it is, so it must be checked before anything else would claim it.
  const r = /^(\d*)r([\s\S])$/.exec(pending)
  if (r) {
    const n = Math.min(COUNT_LIMIT, r[1] ? Number.parseInt(r[1], 10) : 1)
    const line = s.lines[s.row] ?? ''
    if (s.col + n > cpLen(line)) return clear(s) // vim refuses rather than pad
    const lines = [...s.lines]
    lines[s.row] = cpSlice(line, 0, s.col) + r[2].repeat(n) + cpSlice(line, s.col + n)
    return clear({ ...s, lines, col: s.col + n - 1 }, { undo: pushUndo(vim, s) })
  }
  if (/^\d*r$/.test(pending)) return keep(pending)

  // The character an f/F/t/T is looking for: also any key at all.
  const fm = /^(\d*)([dcy<>]?)(\d*)([fFtT])$/.exec(vim.pending)
  if (fm) {
    const count = product(num(fm[1]), num(fm[3]))
    const mo = motion(s, fm[4], count, { arg: ch, lastFind: vim.lastFind })
    if (!mo) return clear(s)
    const lastFind = mo.find ?? vim.lastFind
    if (fm[2]) return applyOperator({ ...vim, lastFind }, s, fm[2], operatorRange(s, mo))
    return clear({ ...s, row: mo.pos.row, col: mo.pos.col }, { lastFind })
  }

  // The object an operator's `i`/`a` names: `diw`, `ca"`, `yi(`.
  const tm = /^(\d*)([dcy<>])(\d*)([ia])$/.exec(vim.pending)
  if (tm) {
    const range = textObject(s, tm[4] as 'i' | 'a', ch)
    if (!range) return clear(s)
    return applyOperator(vim, s, tm[2], range)
  }

  // A count: digits before a command multiply it. A leading `0` is the motion, not
  // a count, which is why this checks for a non-empty count prefix first.
  if (/^\d$/.test(ch) && !(ch === '0' && !/\d$/.test(vim.pending))) {
    if (/^\d*(?:[dcy<>]\d*)?$/.test(pending)) return keep(pending)
  }

  // Everything typed so far, split into [count1][operator][count2][g-prefix].
  const m = /^(\d*)([dcy<>]?)(\d*)(g?)$/.exec(vim.pending)
  if (!m) return clear(s)
  const count1 = num(m[1])
  const op = m[2]
  const count2 = num(m[3])
  const gPrefix = m[4] === 'g'
  const count = product(count1, count2)
  const hasCount = Boolean(count1 || count2)

  // An operator waits for the motion that tells it how far to reach.
  if (!op && !gPrefix && /^[dcy<>]$/.test(ch)) return keep(pending)
  // f/F/t/T wait for their character; an operator's i/a for its object.
  if (!gPrefix && /^[fFtT]$/.test(ch)) return keep(pending)
  if (op && !gPrefix && (ch === 'i' || ch === 'a')) return keep(pending)

  // `g` is only ever a prefix here (`gg`), and it can follow an operator (`dgg`).
  if (!gPrefix && ch === 'g') return keep(pending)
  const cmd = gPrefix && ch === 'g' ? 'gg' : ch

  if (op) {
    // A doubled operator (dd/cc/yy/>>/<<) is the linewise form.
    if (ch === op) {
      const r1 = s.row
      const r2 = Math.min(s.lines.length - 1, s.row + count - 1)
      return applyOperator(vim, s, op, { linewise: true, r1, r2 })
    }
    const mo = motion(s, cmd, count, { lastFind: vim.lastFind })
    if (!mo) return clear(s) // not a motion → the whole command is void, as in vim
    return applyOperator(vim, s, op, operatorRange(s, mo))
  }

  // No operator: a motion moves the cursor.
  const mo = motion(s, cmd, hasCount ? count : 1, { lastFind: vim.lastFind })
  if (mo) {
    const pos = mo.pos
    const next = { ...s, row: pos.row, col: pos.col }
    // `G`/`gg` land on the first non-blank, as vim does.
    if (mo.linewise && (cmd === 'G' || cmd === 'gg')) {
      next.col = firstNonBlank(next.lines[next.row] ?? '')
    }
    return clear(next)
  }

  const insert = (state: EditorState, over: Partial<VimState> = {}): VimResult => ({
    vim: { ...vim, pending: '', mode: 'insert', undo: pushUndo(vim, s), ...over },
    state
  })

  switch (cmd) {
    case 'v':
    case 'V':
      return {
        vim: { ...vim, pending: '', mode: cmd === 'v' ? 'visual' : 'visual-line', anchor: { row: s.row, col: s.col } },
        state: clampNormal(s)
      }
    case 'i':
      return insert(s)
    case 'a': {
      const len = cpLen(s.lines[s.row] ?? '')
      return insert({ ...s, col: Math.min(len, s.col + 1) })
    }
    case 'I':
      return insert({ ...s, col: firstNonBlank(s.lines[s.row] ?? '') })
    case 'A':
      return insert({ ...s, col: cpLen(s.lines[s.row] ?? '') })
    case 'o': {
      const lines = [...s.lines]
      lines.splice(s.row + 1, 0, '')
      return insert({ ...s, lines, row: s.row + 1, col: 0 })
    }
    case 'O': {
      const lines = [...s.lines]
      lines.splice(s.row, 0, '')
      return insert({ ...s, lines, col: 0 })
    }
    case 's': {
      const cut = cutFlat(s, flatIndex(s), flatIndex(s) + count)
      return insert(cut.state, { register: cut.text, registerLinewise: false })
    }
    case 'x': {
      const line = s.lines[s.row] ?? ''
      if (!cpLen(line)) return clear(s)
      const a = flatIndex(s)
      // `x` never eats the line break: it deletes within the line, as vim does.
      const b = Math.min(a + count, a + (cpLen(line) - s.col))
      const cut = cutFlat(s, a, b)
      return clear(cut.state, { register: cut.text, registerLinewise: false, undo: pushUndo(vim, s) })
    }
    case 'X': {
      if (s.col === 0) return clear(s)
      const a = flatIndex(s)
      const b = Math.max(a - count, a - s.col)
      const cut = cutFlat(s, b, a)
      return clear(cut.state, { register: cut.text, registerLinewise: false, undo: pushUndo(vim, s) })
    }
    case 'D': {
      const line = s.lines[s.row] ?? ''
      const cut = cutFlat(s, flatIndex(s), flatIndex(s) + (cpLen(line) - s.col))
      return clear(cut.state, { register: cut.text, registerLinewise: false, undo: pushUndo(vim, s) })
    }
    case 'C': {
      const line = s.lines[s.row] ?? ''
      const cut = cutFlat(s, flatIndex(s), flatIndex(s) + (cpLen(line) - s.col))
      return insert(cut.state, { register: cut.text, registerLinewise: false })
    }
    case 'p':
    case 'P': {
      if (!vim.register) return clear(s)
      const undo = pushUndo(vim, s)
      if (vim.registerLinewise) {
        const body = vim.register.replace(/\n$/, '').split('\n')
        const at = cmd === 'p' ? s.row + 1 : s.row
        const lines = [...s.lines]
        lines.splice(at, 0, ...flatMapCount(body, count))
        return clear({ ...s, lines, row: at, col: firstNonBlank(lines[at]) }, { undo })
      }
      const line = s.lines[s.row] ?? ''
      // Charwise `p` puts AFTER the cursor; `P` before it.
      const at = cmd === 'p' && cpLen(line) ? s.col + 1 : s.col
      const c = flatten(s)
      const i = flatIndex(s, { row: s.row, col: at })
      const text = vim.register.repeat(count)
      const lines = [...c.slice(0, i), ...cps(text), ...c.slice(i)].join('').split('\n')
      // Vim leaves the cursor on the last character it put in.
      const pos = posFromFlat(lines, i + cpLen(text) - 1)
      return clear({ ...s, lines, row: pos.row, col: pos.col }, { undo })
    }
    case 'u': {
      const prev = vim.undo.at(-1)
      if (!prev) return clear(s)
      return {
        vim: { ...vim, pending: '', undo: vim.undo.slice(0, -1) },
        state: clampNormal({ ...s, lines: [...prev.lines], row: prev.row, col: prev.col })
      }
    }
    case '.':
      return repeatChange({ ...vim, pending: '' }, s, hasCount ? count : 0)
    default:
      // An unknown key is not a mistake worth reporting; vim just beeps.
      return clear(s)
  }
}

/** The flat code-point range a visual selection covers. */
function selectionRange(vim: VimState, s: EditorState): Range {
  const anchor = vim.anchor ?? { row: s.row, col: s.col }
  if (vim.mode === 'visual-line') {
    return { linewise: true, r1: Math.min(anchor.row, s.row), r2: Math.max(anchor.row, s.row) }
  }
  const a = flatIndex(s, anchor)
  const b = flatIndex(s)
  const len = flatten(s).length
  // Inclusive of the character under the far end, as a visual selection is.
  return { linewise: false, a: Math.min(a, b), b: Math.min(len, Math.max(a, b) + 1) }
}

/**
 * The selection as per-line `[start, end)` string offsets, for the composer to draw
 * highlighted. Null outside the visual modes.
 */
export function vimSelection(vim: VimState, s: EditorState): Array<Array<{ start: number; end: number }>> | null {
  if (vim.mode !== 'visual' && vim.mode !== 'visual-line') return null
  const range = selectionRange(vim, s)
  const out: Array<Array<{ start: number; end: number }>> = s.lines.map(() => [])
  const off = (line: string, col: number): number => cpSlice(line, 0, col).length
  if (range.linewise) {
    for (let r = range.r1; r <= range.r2; r++) {
      const line = s.lines[r] ?? ''
      // An empty line still shows as selected: one highlighted cell would need text there.
      if (line.length) out[r] = [{ start: 0, end: line.length }]
    }
    return out
  }
  const from = posFromFlat(s.lines, range.a)
  const to = posFromFlat(s.lines, range.b)
  for (let r = from.row; r <= to.row; r++) {
    const line = s.lines[r] ?? ''
    const start = r === from.row ? off(line, from.col) : 0
    const end = r === to.row ? off(line, to.col) : line.length
    if (end > start) out[r] = [{ start, end }]
  }
  return out
}

/** One key in a visual mode. Motions stretch the selection; an operator ends it. */
function visualChar(vim: VimState, s: EditorState, ch: string): VimResult {
  const pending = vim.pending + ch
  if (pending.length > PENDING_LIMIT) return { vim: { ...vim, pending: '' }, state: s }
  const keep = (p: string): VimResult => ({ vim: { ...vim, pending: p }, state: s })
  const move = (state: EditorState, over: Partial<VimState> = {}): VimResult => ({
    vim: { ...vim, pending: '', ...over },
    state: clampNormal(state)
  })

  const fm = /^(\d*)([fFtT])$/.exec(vim.pending)
  if (fm) {
    const mo = motion(s, fm[2], Math.max(1, num(fm[1])), { arg: ch, lastFind: vim.lastFind })
    if (!mo) return move(s)
    return move({ ...s, row: mo.pos.row, col: mo.pos.col }, { lastFind: mo.find ?? vim.lastFind })
  }
  const tm = /^\d*([ia])$/.exec(vim.pending)
  if (tm) {
    const range = textObject(s, tm[1] as 'i' | 'a', ch)
    if (!range || range.linewise || range.b <= range.a) return move(s)
    // Selecting an object is charwise, whatever mode it was typed in (as in vim).
    const start = posFromFlat(s.lines, range.a)
    const end = posFromFlat(s.lines, range.b - 1)
    return move({ ...s, row: end.row, col: end.col }, { mode: 'visual', anchor: start })
  }

  if (/^\d$/.test(ch) && !(ch === '0' && !/\d$/.test(vim.pending))) return keep(pending)
  const m = /^(\d*)(g?)$/.exec(vim.pending)
  if (!m) return move(s)
  const hasCount = Boolean(m[1])
  const count = product(num(m[1]), 0)
  if (!m[2] && (ch === 'g' || ch === 'i' || ch === 'a' || /^[fFtT]$/.test(ch))) return keep(pending)
  const cmd = m[2] && ch === 'g' ? 'gg' : ch

  const mo = motion(s, cmd, hasCount ? count : 1, { lastFind: vim.lastFind })
  if (mo) {
    const next = { ...s, row: mo.pos.row, col: mo.pos.col }
    if (mo.linewise && (cmd === 'G' || cmd === 'gg')) next.col = firstNonBlank(next.lines[next.row] ?? '')
    return move(next)
  }

  const range = selectionRange(vim, s)
  const size = range.linewise ? range.r2 - range.r1 + 1 : range.b - range.a
  const record = (op: string, text: string | null): LastChange => ({
    kind: 'visual',
    op,
    linewise: range.linewise,
    size,
    text
  })
  switch (cmd) {
    case 'o': {
      // The other end: the cursor and the anchor trade places.
      const anchor = vim.anchor ?? { row: s.row, col: s.col }
      return move({ ...s, row: anchor.row, col: anchor.col }, { anchor: { row: s.row, col: s.col } })
    }
    case 'v':
    case 'V': {
      const mode: VimMode = cmd === 'v' ? 'visual' : 'visual-line'
      if (vim.mode === mode) return move(s, { mode: 'normal', anchor: null })
      return move(s, { mode })
    }
    case 'y':
      return applyOperator(vim, s, 'y', range, { cursorToStart: true })
    case 'd':
    case 'x':
      return withChange(applyOperator(vim, s, 'd', range), record('d', null))
    case 'c':
    case 's':
      return withRecording(applyOperator(vim, s, 'c', range), record('c', ''))
    case '>':
    case '<':
      return withChange(applyOperator(vim, s, cmd, range, { times: count }), record(cmd.repeat(count), null))
    default:
      return keep('')
  }
}

function withChange(r: VimResult, change: LastChange): VimResult {
  return { ...r, vim: { ...r.vim, lastChange: change } }
}

function withRecording(r: VimResult, change: LastChange): VimResult {
  return { ...r, vim: { ...r.vim, recording: change } }
}

/**
 * `.`: run the last change again from where the cursor is. A count replaces the
 * one the change was made with (`3.` after `dw` deletes three words).
 */
function repeatChange(vim: VimState, s: EditorState, count: number): VimResult {
  const change = vim.lastChange
  if (!change) return { vim, state: s }
  let cur: VimResult
  if (change.kind === 'keys') {
    const keys = count ? `${count}${change.keys.replace(/^\d+/, '')}` : change.keys
    cur = { vim, state: s }
    for (const k of cps(keys)) cur = normalChar(cur.vim, cur.state, k)
  } else {
    const at = flatIndex(s)
    const size = count || change.size
    const range: Range = change.linewise
      ? { linewise: true, r1: s.row, r2: Math.min(s.lines.length - 1, s.row + size - 1) }
      : { linewise: false, a: at, b: Math.min(flatten(s).length, at + size) }
    const op = change.op.replace(/^([<>])+$/, '$1')
    const times = /^[<>]+$/.test(change.op) ? change.op.length : 1
    cur = applyOperator(vim, s, op, range, { times })
  }
  if (cur.vim.mode === 'insert') {
    const state = change.text ? insertText(cur.state, change.text) : cur.state
    cur = { vim: { ...cur.vim, mode: 'normal' }, state: clampNormal({ ...state, lastEdit: null }) }
  }
  // Replaying is not a new change: what `.` repeats next time stays the same.
  return { ...cur, vim: { ...cur.vim, pending: '', lastChange: change, recording: null } }
}

/** `count` copies of `body`, flattened — for a linewise `3p`. */
function flatMapCount(body: string[], count: number): string[] {
  const out: string[] = []
  for (let i = 0; i < count; i++) out.push(...body)
  return out
}

/** Whether a command changed the text (and so is what `.` repeats). */
function changedLines(a: EditorState, b: EditorState): boolean {
  return a.lines.length !== b.lines.length || a.lines.some((l, i) => l !== b.lines[i])
}

/**
 * One command-mode character, with `.` bookkeeping around it: a finished command
 * that changed the text becomes the last change, and one that opened insert mode
 * starts recording what is typed next.
 */
function commandChar(vim: VimState, s: EditorState, ch: string): VimResult {
  if (vim.mode === 'visual' || vim.mode === 'visual-line') return visualChar(vim, s, ch)
  const keys = vim.pending + ch
  const r = normalChar(vim, s, ch)
  // Still half-typed, or `.`/`u` (which repeat or undo a change, and are not one).
  if (r.vim.pending || ch === '.' || (ch === 'u' && keys === 'u')) return r
  if (r.vim.mode === 'insert') return withRecording(r, { kind: 'keys', keys, text: '' })
  if (r.vim.mode === 'normal' && changedLines(s, r.state)) return withChange(r, { kind: 'keys', keys, text: null })
  return r
}

/** Text typed in insert mode joins the change being recorded for `.`. */
function recordTyped(vim: VimState, text: string): VimState {
  const rec = vim.recording
  if (!rec || rec.text === null) return vim
  const next = rec.text + text
  return { ...vim, recording: next.length > RECORD_LIMIT ? null : { ...rec, text: next } }
}

/** What an insert-mode key does to the recording: typed text joins it, a cursor move ends it. */
function recordInsertKey(vim: VimState, key: EditorKey): VimState {
  if (!vim.recording) return vim
  switch (key.type) {
    case 'char':
    case 'paste':
      return recordTyped(vim, key.value)
    case 'newline':
      return recordTyped(vim, '\n')
    case 'backspace': {
      const rec = vim.recording
      if (!rec.text) return { ...vim, recording: null }
      return { ...vim, recording: { ...rec, text: cps(rec.text).slice(0, -1).join('') } }
    }
    case 'focus':
      return vim
    default:
      // Arrows, kills, history: the insert is no longer one run of typing that `.`
      // could put back faithfully, so it is not repeatable.
      return { ...vim, recording: null }
  }
}

/**
 * The composer's reducer when vim keys are on. Insert mode is the editor, exactly;
 * normal mode interprets. A `char` key can carry several characters at once (the
 * decoder batches a fast typist's run), and in normal mode each one is its own
 * command — so they are folded through one at a time.
 */
export function reduceVim(vim: VimState, s: EditorState, key: EditorKey): VimResult {
  // A reverse-search is its own modal state and owns every key while it is up.
  if (s.search) {
    const r = reduceEditor(s, key)
    return { vim, state: r.state, ...(r.outcome ? { outcome: r.outcome } : {}) }
  }

  if (vim.mode === 'insert') {
    if (key.type === 'escape') {
      // Leaving insert ends a typing run: what is typed after the next `i` is an
      // undo step of its own (Ctrl-_), not a continuation of this one.
      const lastChange = vim.recording ?? vim.lastChange
      return {
        vim: { ...vim, mode: 'normal', pending: '', recording: null, lastChange },
        state: clampNormal({ ...s, lastEdit: null })
      }
    }
    const r = reduceEditor(s, key)
    return { vim: recordInsertKey(vim, key), state: r.state, ...(r.outcome ? { outcome: r.outcome } : {}) }
  }

  const visual = vim.mode === 'visual' || vim.mode === 'visual-line'
  switch (key.type) {
    case 'char': {
      let cur: VimResult = { vim, state: s }
      const chars = cps(key.value)
      for (let i = 0; i < chars.length; i++) {
        cur = commandChar(cur.vim, cur.state, chars[i])
        if (cur.outcome) return cur
        // A command that entered insert mode ("A", "o", "cw") makes the rest of the
        // burst text, as it is for a slower typist: fast typing, autorepeat or a
        // laggy link must not run "hello" as five commands.
        if (cur.vim.mode === 'insert' && i + 1 < chars.length) {
          const rest = chars.slice(i + 1).join('')
          const r = reduceEditor(cur.state, { type: 'char', value: rest })
          return { vim: recordTyped(cur.vim, rest), state: r.state, ...(r.outcome ? { outcome: r.outcome } : {}) }
        }
      }
      return cur
    }
    case 'escape':
      // Esc in a visual mode drops the selection and is back in normal mode.
      if (visual) return { vim: { ...vim, pending: '', mode: 'normal', anchor: null }, state: clampNormal(s) }
      // Esc in normal mode abandons a half-typed command. A double press here, on an
      // empty composer, opens the rewind picker; it never clears text (Esc is how
      // you get to normal mode, so pressing it twice is not a request to discard).
      if (key.double && editorEmpty(s)) return { vim: { ...vim, pending: '' }, state: s, outcome: { kind: 'rewind' } }
      return { vim: { ...vim, pending: '' }, state: s }
    case 'undo':
      // Ctrl-_ in normal mode is `u`: the changes made here are on vim's stack, and
      // two undo histories answering to one key would take back the wrong thing.
      return normalChar({ ...vim, pending: '', mode: 'normal', anchor: null }, s, 'u')
    default: {
      // Everything else (Enter, arrows, Ctrl-C/D/R/L, paste, Tab) means in normal
      // mode exactly what it means in insert mode. Delegating keeps submit, history
      // and interrupt identical in both modes rather than reimplemented in one. In a
      // visual mode an arrow stretches the selection, as a motion would.
      const r = reduceEditor(s, key)
      return { vim: { ...vim, pending: '' }, state: clampNormal(r.state), ...(r.outcome ? { outcome: r.outcome } : {}) }
    }
  }
}
