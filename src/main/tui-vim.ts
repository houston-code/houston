import { reduceEditor, cps, cpLen, cpSlice, type EditorState, type EditorOutcome } from './tui-editor'
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
 * gg G) with counts, operators d c y over any of those motions plus the doubled
 * forms (dd cc yy), x X D C, r, p P, and u. That is the muscle-memory core. What
 * it deliberately does NOT try to be is vim: no registers beyond the unnamed one,
 * no marks, no macros, no visual mode, no text objects (`ciw`), no `.` repeat.
 * A composer is a message box, and each of those wants a real vim underneath.
 */

export type VimMode = 'insert' | 'normal'

/** A buffer snapshot for `u`. */
interface Snapshot {
  lines: string[]
  row: number
  col: number
}

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

export function initialVimState(): VimState {
  return { mode: 'insert', pending: '', register: '', registerLinewise: false, undo: [] }
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

/** The mode marker shown in front of the prompt. */
export function vimStatus(mode: VimMode, paint: Painter): string {
  return mode === 'normal' ? `${paint('N', 'cyan')} ` : `${paint('I', 'dim')} `
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

interface Pos {
  row: number
  col: number
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
  /** The character under `pos` is part of the range (`e`, `$`). */
  inclusive?: boolean
  /** The motion spans whole lines (`j`, `k`, `G`, `gg`). */
  linewise?: boolean
}

/**
 * Resolve a motion key to a target. Returns null when the key isn't a motion, so
 * the caller can tell "not a motion" from "a motion that went nowhere".
 */
function motion(s: EditorState, key: string, count: number): MotionResult | null {
  const line = s.lines[s.row] ?? ''
  const lastRow = s.lines.length - 1
  const c = flatten(s)
  const i = flatIndex(s)

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
      let j = i
      for (let n = 0; n < count; n++) j = fwdWord(c, j, key === 'W')
      return { pos: posFromFlat(s.lines, j) }
    }
    case 'b':
    case 'B': {
      let j = i
      for (let n = 0; n < count; n++) j = backWord(c, j, key === 'B')
      return { pos: posFromFlat(s.lines, j) }
    }
    case 'e':
    case 'E': {
      let j = i
      for (let n = 0; n < count; n++) j = endWord(c, j, key === 'E')
      return { pos: posFromFlat(s.lines, j), inclusive: true }
    }
    case 'G':
      return { pos: { row: lastRow, col: 0 }, linewise: true }
    case 'gg':
      // `3gg` goes to line 3; a bare `gg` to the first line.
      return { pos: { row: Math.min(lastRow, count - 1), col: 0 }, linewise: true }
    default:
      return null
  }
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
function operatorRange(
  s: EditorState,
  m: MotionResult
): { linewise: true; r1: number; r2: number } | { linewise: false; a: number; b: number } {
  if (m.linewise) return { linewise: true, r1: s.row, r2: m.pos.row }
  const a = flatIndex(s)
  const b = flatIndex(s, m.pos) + (m.inclusive ? 1 : 0)
  return { linewise: false, a: Math.min(a, b), b: Math.max(a, b) }
}

interface VimResult {
  vim: VimState
  state: EditorState
  outcome?: EditorOutcome
}

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
    const n = r[1] ? Number.parseInt(r[1], 10) : 1
    const line = s.lines[s.row] ?? ''
    if (s.col + n > cpLen(line)) return clear(s) // vim refuses rather than pad
    const lines = [...s.lines]
    lines[s.row] = cpSlice(line, 0, s.col) + r[2].repeat(n) + cpSlice(line, s.col + n)
    return clear({ ...s, lines, col: s.col + n - 1 }, { undo: pushUndo(vim, s) })
  }
  if (/^\d*r$/.test(pending)) return keep(pending)

  // A count: digits before a command multiply it. A leading `0` is the motion, not
  // a count, which is why this checks for a non-empty count prefix first.
  if (/^\d$/.test(ch) && !(ch === '0' && !/\d$/.test(vim.pending))) {
    if (/^\d*(?:[dcy]\d*)?$/.test(pending)) return keep(pending)
  }

  // Everything typed so far, split into [count1][operator][count2][g-prefix].
  const m = /^(\d*)([dcy]?)(\d*)(g?)$/.exec(vim.pending)
  if (!m) return clear(s)
  const count1 = m[1] ? Number.parseInt(m[1], 10) : 0
  const op = m[2]
  const count2 = m[3] ? Number.parseInt(m[3], 10) : 0
  const gPrefix = m[4] === 'g'
  const count = Math.min(COUNT_LIMIT, Math.max(1, count1 || 1) * Math.max(1, count2 || 1))
  const hasCount = Boolean(count1 || count2)

  // An operator waits for the motion that tells it how far to reach.
  if (!op && !gPrefix && /^[dcy]$/.test(ch)) return keep(pending)

  // `g` is only ever a prefix here (`gg`), and it can follow an operator (`dgg`).
  if (!gPrefix && ch === 'g') return keep(pending)
  const cmd = gPrefix && ch === 'g' ? 'gg' : ch

  if (op) {
    // A doubled operator (dd/cc/yy) is the linewise form.
    if (ch === op) {
      const r1 = s.row
      const r2 = Math.min(s.lines.length - 1, s.row + count - 1)
      if (op === 'y') {
        const text = `${s.lines.slice(r1, r2 + 1).join('\n')}\n`
        return clear(s, { register: text, registerLinewise: true })
      }
      const cut = cutLines(s, r1, r2)
      if (op === 'c') {
        // `cc` keeps the line and empties it; `dd` takes the line away.
        const lines = [...s.lines]
        lines.splice(r1, r2 - r1 + 1, '')
        return {
          vim: { ...vim, pending: '', mode: 'insert', register: cut.text, registerLinewise: true, undo: pushUndo(vim, s) },
          state: { ...s, lines, row: r1, col: 0 }
        }
      }
      return clear(cut.state, { register: cut.text, registerLinewise: true, undo: pushUndo(vim, s) })
    }

    const mo = motion(s, cmd, count)
    if (!mo) return clear(s) // not a motion → the whole command is void, as in vim
    const range = operatorRange(s, mo)
    if (op === 'y') {
      if (range.linewise) {
        const text = `${s.lines.slice(Math.min(range.r1, range.r2), Math.max(range.r1, range.r2) + 1).join('\n')}\n`
        return clear(s, { register: text, registerLinewise: true })
      }
      const text = flatten(s).slice(range.a, range.b).join('')
      // Yank leaves the cursor at the start of what it took.
      const pos = posFromFlat(s.lines, range.a)
      return clear({ ...s, row: pos.row, col: pos.col }, { register: text, registerLinewise: false })
    }
    const cut = range.linewise ? cutLines(s, range.r1, range.r2) : cutFlat(s, range.a, range.b)
    if (op === 'c') {
      return {
        vim: {
          ...vim,
          pending: '',
          mode: 'insert',
          register: cut.text,
          registerLinewise: Boolean(range.linewise),
          undo: pushUndo(vim, s)
        },
        state: cut.state
      }
    }
    return clear(cut.state, {
      register: cut.text,
      registerLinewise: Boolean(range.linewise),
      undo: pushUndo(vim, s)
    })
  }

  // No operator: a motion moves the cursor.
  const mo = motion(s, cmd, hasCount ? count : 1)
  if (mo) {
    const pos = mo.pos
    const next = { ...s, row: pos.row, col: pos.col }
    // `G`/`gg` land on the first non-blank, as vim does.
    if (mo.linewise && (cmd === 'G' || cmd === 'gg')) {
      next.col = firstNonBlank(next.lines[next.row] ?? '')
    }
    return clear(next)
  }

  switch (cmd) {
    case 'i':
      return { vim: { ...vim, pending: '', mode: 'insert', undo: pushUndo(vim, s) }, state: s }
    case 'a': {
      const len = cpLen(s.lines[s.row] ?? '')
      return {
        vim: { ...vim, pending: '', mode: 'insert', undo: pushUndo(vim, s) },
        state: { ...s, col: Math.min(len, s.col + 1) }
      }
    }
    case 'I':
      return {
        vim: { ...vim, pending: '', mode: 'insert', undo: pushUndo(vim, s) },
        state: { ...s, col: firstNonBlank(s.lines[s.row] ?? '') }
      }
    case 'A':
      return {
        vim: { ...vim, pending: '', mode: 'insert', undo: pushUndo(vim, s) },
        state: { ...s, col: cpLen(s.lines[s.row] ?? '') }
      }
    case 'o': {
      const lines = [...s.lines]
      lines.splice(s.row + 1, 0, '')
      return {
        vim: { ...vim, pending: '', mode: 'insert', undo: pushUndo(vim, s) },
        state: { ...s, lines, row: s.row + 1, col: 0 }
      }
    }
    case 'O': {
      const lines = [...s.lines]
      lines.splice(s.row, 0, '')
      return {
        vim: { ...vim, pending: '', mode: 'insert', undo: pushUndo(vim, s) },
        state: { ...s, lines, col: 0 }
      }
    }
    case 's': {
      const cut = cutFlat(s, flatIndex(s), flatIndex(s) + count)
      return {
        vim: { ...vim, pending: '', mode: 'insert', register: cut.text, registerLinewise: false, undo: pushUndo(vim, s) },
        state: cut.state
      }
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
      return {
        vim: { ...vim, pending: '', mode: 'insert', register: cut.text, registerLinewise: false, undo: pushUndo(vim, s) },
        state: cut.state
      }
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
    default:
      // An unknown key is not a mistake worth reporting; vim just beeps.
      return clear(s)
  }
}

/** `count` copies of `body`, flattened — for a linewise `3p`. */
function flatMapCount(body: string[], count: number): string[] {
  const out: string[] = []
  for (let i = 0; i < count; i++) out.push(...body)
  return out
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
      return { vim: { ...vim, mode: 'normal', pending: '' }, state: clampNormal(s) }
    }
    const r = reduceEditor(s, key)
    return { vim, state: r.state, ...(r.outcome ? { outcome: r.outcome } : {}) }
  }

  switch (key.type) {
    case 'char': {
      let cur: VimResult = { vim, state: s }
      for (const ch of cps(key.value)) {
        cur = normalChar(cur.vim, cur.state, ch)
        if (cur.outcome) return cur
      }
      return cur
    }
    case 'escape':
      // Esc in normal mode abandons a half-typed command.
      return { vim: { ...vim, pending: '' }, state: s }
    default: {
      // Everything else (Enter, arrows, Ctrl-C/D/R/L, paste, Tab) means in normal
      // mode exactly what it means in insert mode. Delegating keeps submit, history
      // and interrupt identical in both modes rather than reimplemented in one.
      const r = reduceEditor(s, key)
      const moved = vim.mode === 'normal' ? clampNormal(r.state) : r.state
      return { vim: { ...vim, pending: '' }, state: moved, ...(r.outcome ? { outcome: r.outcome } : {}) }
    }
  }
}
