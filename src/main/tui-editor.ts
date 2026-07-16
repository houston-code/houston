import { charWidth, visibleWidth } from './tui-wrap'
import type { EditorKey } from './tui-keys'
import type { Painter } from './tui'

/**
 * The composer's editor model: a pure buffer + cursor + history machine, with a
 * pure view. The terminal specifics (raw mode, decoding, redraw) live in tui-io.ts
 * behind the `TuiIo.readComposer` seam — the same split the picker uses, so the
 * interesting logic is unit-testable with no TTY.
 *
 * This replaces node:readline for the composer. readline gave emacs keys and
 * history for free, but it decides what a "line" is, and that decision is what
 * lost multi-line pastes: it delivered a pasted block one line at a time, and the
 * first line submitted as a whole turn while the rest was interpreted as further
 * lines. Owning the buffer is what makes a paste land as one editable block.
 *
 * The buffer is a list of logical lines. Enter submits the whole thing; Ctrl-J,
 * Alt-Enter, and any pasted line break insert a real newline instead.
 */

/**
 * A large paste, held out of the visible buffer behind a placeholder token. The
 * token is what the user sees and edits around; `text` is substituted back in on
 * submit, so pasting a 500-line file doesn't bury the composer.
 */
export interface PasteBlob {
  token: string
  text: string
}

/** Incremental reverse-search (Ctrl-R) state: the typed query and the match cursor. */
export interface SearchState {
  query: string
  /** Index into `history` of the current match, or null when nothing matches. */
  index: number | null
}

export interface EditorState {
  /** Logical lines of the draft (never empty: always at least one, possibly ''). */
  lines: string[]
  /** Cursor's logical line. */
  row: number
  /** Cursor's offset within `lines[row]`, counted in code points. */
  col: number
  /** Persisted history, newest last. */
  history: string[]
  /** Position while navigating history, or null when editing the live draft. */
  histIndex: number | null
  /** The live draft, stashed while history navigation borrows the buffer. */
  stash: string[] | null
  /** Reverse-search state, or null when not searching. */
  search: SearchState | null
  /** Collapsed pastes, expanded on submit. */
  blobs: PasteBlob[]
  /** Last killed text (Ctrl-K/U/W), for Ctrl-Y. */
  kill: string
}

export type EditorOutcome =
  | { kind: 'submit'; text: string }
  | { kind: 'interrupt' }
  | { kind: 'eof' }
  /** Tab: the adapter runs completion (it needs async file I/O) and applies the result. */
  | { kind: 'complete' }
  /** Ctrl-X Ctrl-E: the adapter hands `text` to $EDITOR and feeds the result back. */
  | { kind: 'external-edit'; text: string }
  /** Ctrl-L: the adapter clears the screen and repaints. */
  | { kind: 'clear-screen' }
  /** Shift-Tab: the adapter cycles the approval mode and redraws the prompt. */
  | { kind: 'cycle-mode' }

/** A paste at least this many lines (or this many characters) collapses to a token. */
export const PASTE_COLLAPSE_LINES = 5
export const PASTE_COLLAPSE_CHARS = 800

export function initialEditorState(history: string[] = []): EditorState {
  return {
    lines: [''],
    row: 0,
    col: 0,
    history,
    histIndex: null,
    stash: null,
    search: null,
    blobs: [],
    kill: ''
  }
}

/** The draft as text, with collapsed pastes substituted back in. */
export function editorText(s: EditorState): string {
  return expandBlobs(s.lines.join('\n'), s.blobs)
}

/**
 * Replace each paste placeholder with the text it stands for. Only the FIRST
 * occurrence of each token expands: the composer inserts a token exactly once, so
 * a second copy is text the user typed or pasted, and expanding it would send
 * something other than what they reviewed.
 */
export function expandBlobs(text: string, blobs: PasteBlob[]): string {
  let out = text
  for (const b of blobs) {
    const at = out.indexOf(b.token)
    if (at >= 0) out = out.slice(0, at) + b.text + out.slice(at + b.token.length)
  }
  return out
}

/** The placeholder shown for a collapsed paste. */
export function blobToken(index: number, text: string): string {
  const lines = text.split('\n').length
  return lines > 1 ? `[#${index} pasted ${lines} lines]` : `[#${index} pasted ${text.length} chars]`
}

/**
 * A placeholder that does not already appear in `haystack`. Without this, text
 * that happens to contain a future token's exact spelling would be swapped for
 * that paste's body on submit — so what was reviewed is not what gets sent.
 */
function freshBlobToken(haystack: string, from: number, text: string): string {
  let index = from
  let token = blobToken(index, text)
  while (haystack.includes(token)) token = blobToken(++index, text)
  return token
}

const cps = (s: string): string[] => [...s]
const cpLen = (s: string): number => cps(s).length
const cpSlice = (s: string, a: number, b?: number): string => cps(s).slice(a, b).join('')

/** Start of the word before `col`, for Ctrl-W / Alt-B. */
function wordStart(line: string, col: number): number {
  const c = cps(line)
  let i = col
  while (i > 0 && /\s/.test(c[i - 1])) i--
  while (i > 0 && !/\s/.test(c[i - 1])) i--
  return i
}

/** End of the word after `col`, for Alt-F. */
function wordEnd(line: string, col: number): number {
  const c = cps(line)
  let i = col
  while (i < c.length && /\s/.test(c[i])) i++
  while (i < c.length && !/\s/.test(c[i])) i++
  return i
}

/** Insert `text` (which may contain newlines) at the cursor, returning the next state. */
export function insertText(s: EditorState, text: string): EditorState {
  const line = s.lines[s.row] ?? ''
  const before = cpSlice(line, 0, s.col)
  const after = cpSlice(line, s.col)
  const parts = text.split('\n')
  if (parts.length === 1) {
    const lines = [...s.lines]
    lines[s.row] = before + text + after
    return { ...s, lines, col: s.col + cpLen(text) }
  }
  const inserted = [
    before + parts[0],
    ...parts.slice(1, -1),
    parts[parts.length - 1] + after
  ]
  const lines = [...s.lines.slice(0, s.row), ...inserted, ...s.lines.slice(s.row + 1)]
  return {
    ...s,
    lines,
    row: s.row + parts.length - 1,
    col: cpLen(parts[parts.length - 1])
  }
}

/**
 * Replace the whole draft with `text`, cursor at the end — the way back in from
 * an $EDITOR round trip, where the returned text is already blob-expanded.
 */
export function setEditorText(s: EditorState, text: string): EditorState {
  return loadBuffer({ ...s, blobs: [], stash: null }, text, null)
}

/** Load a history entry (or the stashed draft) into the buffer, cursor at the end. */
function loadBuffer(s: EditorState, text: string, histIndex: number | null): EditorState {
  const lines = text.split('\n')
  return {
    ...s,
    lines,
    row: lines.length - 1,
    col: cpLen(lines[lines.length - 1]),
    histIndex
  }
}

/** The most recent history entry at or before `before` containing `query`. */
export function findHistoryMatch(
  history: string[],
  query: string,
  before: number
): number | null {
  if (!query) return null
  for (let i = Math.min(before, history.length - 1); i >= 0; i--) {
    if (history[i].includes(query)) return i
  }
  return null
}

/** Reverse-search key handling, split out to keep `reduceEditor` readable. */
function reduceSearch(s: EditorState, key: EditorKey): { state: EditorState; outcome?: EditorOutcome } {
  const search = s.search as SearchState
  const accept = (): EditorState => {
    const hit = search.index !== null ? s.history[search.index] : null
    const next = { ...s, search: null }
    return hit !== null && hit !== undefined ? loadBuffer(next, hit, search.index) : next
  }
  switch (key.type) {
    case 'char': {
      const query = search.query + key.value
      return { state: { ...s, search: { query, index: findHistoryMatch(s.history, query, s.history.length - 1) } } }
    }
    case 'backspace': {
      const query = cpSlice(search.query, 0, Math.max(0, cpLen(search.query) - 1))
      return { state: { ...s, search: { query, index: findHistoryMatch(s.history, query, s.history.length - 1) } } }
    }
    case 'search': {
      // Another Ctrl-R steps to the next older match.
      const from = search.index === null ? s.history.length - 1 : search.index - 1
      const index = findHistoryMatch(s.history, search.query, from)
      return { state: { ...s, search: { ...search, index: index ?? search.index } } }
    }
    case 'enter':
      return { state: accept() }
    case 'escape':
    case 'interrupt':
      // Abandon the search, keeping the draft that was there before it started.
      return { state: { ...s, search: null } }
    default:
      // Any cursor movement accepts the match and resumes normal editing.
      return reduceEditor(accept(), key)
  }
}

/**
 * Advance the editor by one key. Pure: returns the next state and, when the read
 * is over (or needs the adapter's help), an outcome.
 */
export function reduceEditor(s: EditorState, key: EditorKey): { state: EditorState; outcome?: EditorOutcome } {
  if (s.search) return reduceSearch(s, key)
  const line = s.lines[s.row] ?? ''
  const lastRow = s.lines.length - 1

  switch (key.type) {
    case 'char':
      return { state: insertText(s, key.value) }

    case 'paste': {
      const text = key.value
      if (!text) return { state: s }
      const big = text.split('\n').length > PASTE_COLLAPSE_LINES || text.length > PASTE_COLLAPSE_CHARS
      if (!big) return { state: insertText(s, text) }
      const token = freshBlobToken(s.lines.join('\n'), s.blobs.length + 1, text)
      const withBlob = { ...s, blobs: [...s.blobs, { token, text }] }
      return { state: insertText(withBlob, token) }
    }

    case 'enter':
      return { state: s, outcome: { kind: 'submit', text: editorText(s) } }

    case 'newline':
      return { state: insertText(s, '\n') }

    case 'backspace': {
      if (s.col > 0) {
        const lines = [...s.lines]
        lines[s.row] = cpSlice(line, 0, s.col - 1) + cpSlice(line, s.col)
        return { state: { ...s, lines, col: s.col - 1 } }
      }
      if (s.row === 0) return { state: s }
      // Join with the previous line.
      const prev = s.lines[s.row - 1]
      const lines = [...s.lines]
      lines[s.row - 1] = prev + line
      lines.splice(s.row, 1)
      return { state: { ...s, lines, row: s.row - 1, col: cpLen(prev) } }
    }

    case 'delete': {
      if (s.col < cpLen(line)) {
        const lines = [...s.lines]
        lines[s.row] = cpSlice(line, 0, s.col) + cpSlice(line, s.col + 1)
        return { state: { ...s, lines } }
      }
      if (s.row === lastRow) return { state: s }
      const lines = [...s.lines]
      lines[s.row] = line + lines[s.row + 1]
      lines.splice(s.row + 1, 1)
      return { state: { ...s, lines } }
    }

    case 'left':
      if (s.col > 0) return { state: { ...s, col: s.col - 1 } }
      if (s.row > 0) return { state: { ...s, row: s.row - 1, col: cpLen(s.lines[s.row - 1]) } }
      return { state: s }

    case 'right':
      if (s.col < cpLen(line)) return { state: { ...s, col: s.col + 1 } }
      if (s.row < lastRow) return { state: { ...s, row: s.row + 1, col: 0 } }
      return { state: s }

    case 'up': {
      // Within a multi-line draft Up moves a line; only at the top does it reach
      // for history (matching every other line editor).
      if (s.row > 0) {
        const target = s.lines[s.row - 1]
        return { state: { ...s, row: s.row - 1, col: Math.min(s.col, cpLen(target)) } }
      }
      const at = s.histIndex === null ? s.history.length : s.histIndex
      if (at <= 0) return { state: s }
      const stash = s.histIndex === null ? s.lines : s.stash
      return { state: loadBuffer({ ...s, stash }, s.history[at - 1], at - 1) }
    }

    case 'down': {
      if (s.row < lastRow) {
        const target = s.lines[s.row + 1]
        return { state: { ...s, row: s.row + 1, col: Math.min(s.col, cpLen(target)) } }
      }
      if (s.histIndex === null) return { state: s }
      const at = s.histIndex + 1
      if (at >= s.history.length) {
        // Past the newest entry: restore the draft the user was writing.
        const draft = s.stash ?? ['']
        return { state: { ...loadBuffer(s, draft.join('\n'), null), stash: null } }
      }
      return { state: loadBuffer(s, s.history[at], at) }
    }

    case 'home':
      return { state: { ...s, col: 0 } }

    case 'end':
      return { state: { ...s, col: cpLen(line) } }

    case 'word-left': {
      if (s.col === 0 && s.row > 0) return { state: { ...s, row: s.row - 1, col: cpLen(s.lines[s.row - 1]) } }
      return { state: { ...s, col: wordStart(line, s.col) } }
    }

    case 'word-right': {
      if (s.col === cpLen(line) && s.row < lastRow) return { state: { ...s, row: s.row + 1, col: 0 } }
      return { state: { ...s, col: wordEnd(line, s.col) } }
    }

    case 'kill-line': {
      const lines = [...s.lines]
      const killed = cpSlice(line, s.col)
      lines[s.row] = cpSlice(line, 0, s.col)
      return { state: { ...s, lines, kill: killed || s.kill } }
    }

    case 'kill-to-start': {
      const lines = [...s.lines]
      const killed = cpSlice(line, 0, s.col)
      lines[s.row] = cpSlice(line, s.col)
      return { state: { ...s, lines, col: 0, kill: killed || s.kill } }
    }

    case 'kill-word': {
      const start = wordStart(line, s.col)
      if (start === s.col) return { state: s }
      const lines = [...s.lines]
      const killed = cpSlice(line, start, s.col)
      lines[s.row] = cpSlice(line, 0, start) + cpSlice(line, s.col)
      return { state: { ...s, lines, col: start, kill: killed } }
    }

    case 'yank':
      return s.kill ? { state: insertText(s, s.kill) } : { state: s }

    case 'search':
      return { state: { ...s, search: { query: '', index: null } } }

    case 'tab':
      return { state: s, outcome: { kind: 'complete' } }

    case 'interrupt':
      return { state: s, outcome: { kind: 'interrupt' } }

    case 'eof':
      // Ctrl-D on a non-empty draft deletes forward (readline's behavior); only an
      // empty composer treats it as end-of-input.
      if (s.lines.length === 1 && s.lines[0] === '') return { state: s, outcome: { kind: 'eof' } }
      return reduceEditor(s, { type: 'delete' })

    case 'external-edit':
      return { state: s, outcome: { kind: 'external-edit', text: editorText(s) } }

    case 'clear-screen':
      return { state: s, outcome: { kind: 'clear-screen' } }

    case 'escape':
      return { state: s }

    case 'focus':
      // The terminal telling us it gained/lost focus. Not input: the adapter reads
      // it to gate attention signals; the buffer is unaffected.
      return { state: s }

    case 'cycle-mode':
      // The draft survives: changing how much runs without asking has nothing to do
      // with what you were typing.
      return { state: s, outcome: { kind: 'cycle-mode' } }
  }
}

/** Display rows plus the cursor's position within them. */
export interface EditorView {
  rows: string[]
  cursorRow: number
  cursorCol: number
}

/** Hard-split into chunks of at most `width` columns (wide chars never split). */
function splitToWidth(s: string, width: number): string[] {
  const out: string[] = []
  let cur = ''
  let w = 0
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0) ?? 0)
    if (w + cw > width && cur) {
      out.push(cur)
      cur = ''
      w = 0
    }
    cur += ch
    w += cw
  }
  out.push(cur)
  return out
}

/**
 * Render the composer to exact display rows plus a cursor position. The adapter
 * erases exactly `rows.length` lines before redrawing, so the composer behaves
 * like the picker: a bounded live region, never a full-screen repaint.
 *
 * Wrapping is a hard split at the terminal width (not word wrap) so the cursor
 * math is exact — a word-wrapped composer can't reliably place the cursor.
 */
export function renderEditor(
  s: EditorState,
  opts: {
    prompt: string
    width: number
    paint: Painter
    continuation?: string
    /**
     * Rows drawn UNDER the composer (the live command menu). They are part of the
     * redraw region, so the adapter erases them with everything else; the cursor
     * stays in the composer above them.
     */
    below?: string[]
  }
): EditorView {
  const width = Math.max(8, opts.width)
  if (s.search) {
    const hit = s.search.index !== null ? s.history[s.search.index] : ''
    const label = `(reverse-i-search)\`${s.search.query}': `
    const row = opts.paint(label, 'dim') + (hit ?? '')
    return { rows: [row], cursorRow: 0, cursorCol: Math.min(width - 1, visibleWidth(label)) }
  }

  const promptWidth = visibleWidth(opts.prompt)
  const cont = opts.continuation ?? ''
  const contWidth = visibleWidth(cont)
  const rows: string[] = []
  let cursorRow = 0
  let cursorCol = 0

  s.lines.forEach((line, i) => {
    const lead = i === 0 ? promptWidth : contWidth
    const chunks = splitToWidth(line, width - lead)
    if (i === s.row) {
      // Cursor: which chunk holds `col`, and where in it.
      const before = visibleWidth(cpSlice(line, 0, s.col))
      const chunkIndex = Math.min(Math.floor(before / Math.max(1, width - lead)), chunks.length - 1)
      cursorRow = rows.length + chunkIndex
      cursorCol = lead + (before - chunkIndex * (width - lead))
      // A cursor exactly at the wrap boundary sits at the start of the next row.
      if (cursorCol >= width) {
        cursorRow += 1
        cursorCol = lead
      }
    }
    chunks.forEach((chunk, j) => {
      const prefix = i === 0 && j === 0 ? opts.prompt : j === 0 ? cont : ' '.repeat(lead)
      rows.push(prefix + chunk)
    })
  })

  // Guarantee a row for a cursor that landed past the last rendered row.
  while (cursorRow >= rows.length) rows.push('')
  // The menu goes after that guard: it must never be mistaken for a buffer line.
  if (opts.below?.length) rows.push(...opts.below)
  return { rows, cursorRow, cursorCol }
}
