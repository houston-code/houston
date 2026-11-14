import { clusterWidth, graphemes, truncateVisible, truncateVisibleStart, visibleWidth } from './tui-wrap'
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

/** The draft as it stood at one moment: what undo, redo and the Ctrl-S stash hold. */
export interface DraftSnapshot {
  lines: string[]
  row: number
  col: number
  blobs: PasteBlob[]
}

/**
 * What the last edit was, so a run of the same kind collapses into one undo step:
 * typing a word and then undoing should take back the word, not one letter.
 */
export type EditKind = 'type' | 'erase'

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
  /** Drafts before each edit step, oldest first, for Ctrl-_. */
  undo: DraftSnapshot[]
  /** Drafts undo took back, newest last, for Ctrl-^. Cleared by any new edit. */
  redo: DraftSnapshot[]
  /** The kind of the previous key's edit, or null when it was not a coalescing edit. */
  lastEdit: EditKind | null
  /** The draft Ctrl-S put aside, restored by Ctrl-S on an empty composer. */
  stashed: DraftSnapshot | null
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
  /** Ctrl-O: the adapter opens the transcript viewer, then restores the composer as it was. */
  | { kind: 'transcript' }
  /** Alt-T: the adapter steps the reasoning display and redraws. */
  | { kind: 'cycle-thoughts' }
  /**
   * Not the end of the read: `text` left the buffer without being sent (Esc Esc
   * cleared it, or a newer Ctrl-S stash displaced it). The adapter saves it to
   * history so Up brings it back, and keeps editing.
   */
  | { kind: 'remember'; text: string }
  /** Esc Esc on an empty composer: the adapter closes the read and opens the rewind picker. */
  | { kind: 'rewind' }
  /** Ctrl-V / Alt-V: the adapter attaches the clipboard image; the buffer is unchanged. */
  | { kind: 'paste-image' }
  /** Ctrl-Z: the adapter hands the terminal back and stops the process. */
  | { kind: 'suspend' }

/** Deepest undo history a read keeps. A draft is short; this is already generous. */
export const UNDO_LIMIT = 100

/** A paste at least this many lines (or this many characters) collapses to a token. */
export const PASTE_COLLAPSE_LINES = 5
export const PASTE_COLLAPSE_CHARS = 800

export function initialEditorState(
  history: string[] = [],
  draft = '',
  stashed: DraftSnapshot | null = null
): EditorState {
  // A pre-filled draft opens with the cursor at its end, ready to edit or send.
  const lines = draft.split('\n')
  return {
    lines,
    row: lines.length - 1,
    col: [...lines[lines.length - 1]].length,
    history,
    histIndex: null,
    stash: null,
    search: null,
    blobs: [],
    kill: '',
    undo: [],
    redo: [],
    lastEdit: null,
    stashed
  }
}

/** Whether the draft has nothing in it. */
export function editorEmpty(s: EditorState): boolean {
  return s.lines.every((l) => l.length === 0)
}

function snapshotOf(s: EditorState): DraftSnapshot {
  return { lines: [...s.lines], row: s.row, col: s.col, blobs: [...s.blobs] }
}

/** Put a snapshot back into the buffer. Leaves history browsing: this is a live draft. */
function restoreSnapshot(s: EditorState, snap: DraftSnapshot): EditorState {
  return { ...s, lines: [...snap.lines], row: snap.row, col: snap.col, blobs: [...snap.blobs], histIndex: null, stash: null }
}

/** An empty buffer (history, kill ring and undo history untouched). */
function clearedBuffer(s: EditorState): EditorState {
  return { ...s, lines: [''], row: 0, col: 0, blobs: [], histIndex: null, stash: null }
}

/** `text` appended to the in-read history (so Up reaches it now), skipping a repeat. */
function withHistoryEntry(history: string[], text: string): string[] {
  const t = text.trim()
  if (!t || history[history.length - 1] === t) return history
  return [...history, t]
}

/** The keys that change the draft's text, and so make an undo step. */
const EDIT_KEYS = new Set<EditorKey['type']>([
  'char',
  'paste',
  'newline',
  'backspace',
  'delete',
  'kill-line',
  'kill-to-start',
  'kill-word',
  'yank',
  'eof' // Ctrl-D on a non-empty draft deletes forward
])

function sameDraft(a: EditorState, b: EditorState): boolean {
  if (a.blobs.length !== b.blobs.length || a.lines.length !== b.lines.length) return false
  return a.lines.every((l, i) => l === b.lines[i]) && a.blobs.every((x, i) => x === b.blobs[i])
}

/**
 * Record an edit step: `before` goes on the undo stack unless this key continues a
 * run of the same kind (typing, or erasing) that is already one step.
 */
function recordEdit(before: EditorState, after: EditorState, kind: EditKind | null): EditorState {
  const coalesce = kind !== null && before.lastEdit === kind && before.undo.length > 0
  const undo = coalesce ? before.undo : [...before.undo, snapshotOf(before)].slice(-UNDO_LIMIT)
  return { ...after, undo, redo: [], lastEdit: kind }
}

/**
 * Ctrl-_ / Ctrl-^ / Ctrl-S / Esc Esc: the draft-level keys, handled around the
 * per-key editing below so they can see each step as a whole.
 */
function reduceDraftKey(s: EditorState, key: EditorKey): { state: EditorState; outcome?: EditorOutcome } | null {
  switch (key.type) {
    case 'undo': {
      const prev = s.undo[s.undo.length - 1]
      if (!prev) return { state: { ...s, lastEdit: null } }
      const back = restoreSnapshot(s, prev)
      return { state: { ...back, undo: s.undo.slice(0, -1), redo: [...s.redo, snapshotOf(s)], lastEdit: null } }
    }
    case 'redo': {
      const next = s.redo[s.redo.length - 1]
      if (!next) return { state: { ...s, lastEdit: null } }
      const fwd = restoreSnapshot(s, next)
      return { state: { ...fwd, undo: [...s.undo, snapshotOf(s)].slice(-UNDO_LIMIT), redo: s.redo.slice(0, -1), lastEdit: null } }
    }
    case 'stash': {
      if (editorEmpty(s)) {
        // Nothing typed: bring the stash back, if there is one.
        if (!s.stashed) return { state: s }
        const back = restoreSnapshot(s, s.stashed)
        return { state: recordEdit(s, { ...back, stashed: null }, null) }
      }
      // Put this draft aside. An older stash is not thrown away: it goes to
      // history, where Up finds it.
      const older = s.stashed ? expandBlobs(s.stashed.lines.join('\n'), s.stashed.blobs) : ''
      const cleared = clearedBuffer({ ...s, stashed: snapshotOf(s), history: withHistoryEntry(s.history, older) })
      const state = recordEdit(s, cleared, null)
      return older.trim() ? { state, outcome: { kind: 'remember', text: older } } : { state }
    }
    case 'escape': {
      if (!key.double) return null
      if (editorEmpty(s)) return { state: s, outcome: { kind: 'rewind' } }
      // Clear the draft, keeping it in history so Up brings it back (and undo too).
      const text = editorText(s)
      const cleared = clearedBuffer({ ...s, history: withHistoryEntry(s.history, text) })
      return { state: recordEdit(s, cleared, null), outcome: { kind: 'remember', text } }
    }
    default:
      return null
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

// Code-point helpers. Exported for the vim layer (tui-vim.ts), which does its own
// buffer surgery and must count exactly as the editor does — an astral character
// is one cursor step here, and two `.length` units in a naive implementation.
export const cps = (s: string): string[] => [...s]
export const cpLen = (s: string): number => cps(s).length
export const cpSlice = (s: string, a: number, b?: number): string => cps(s).slice(a, b).join('')

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
  const next = loadBuffer({ ...s, blobs: [], stash: null }, text, null)
  // An $EDITOR round trip is one step: undo takes the whole edit back.
  return sameDraft(s, next) ? next : recordEdit(s, next, null)
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
  const draftKey = reduceDraftKey(s, key)
  if (draftKey) return draftKey
  const r = reduceKey(s, key)
  if (!EDIT_KEYS.has(key.type) || sameDraft(s, r.state)) {
    // Moving the cursor (or a key that changed nothing) ends a typing run, so the
    // next letters are a step of their own.
    return r.state.lastEdit === null ? r : { ...r, state: { ...r.state, lastEdit: null } }
  }
  const kind: EditKind | null =
    key.type === 'char' ? 'type' : key.type === 'backspace' || key.type === 'delete' ? 'erase' : null
  return { ...r, state: recordEdit(s, r.state, kind) }
}

/** One key's effect on the buffer, before undo bookkeeping. */
function reduceKey(s: EditorState, key: EditorKey): { state: EditorState; outcome?: EditorOutcome } {
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
      return reduceKey(s, { type: 'delete' })

    case 'external-edit':
      return { state: s, outcome: { kind: 'external-edit', text: editorText(s) } }

    case 'paste-image':
      return { state: s, outcome: { kind: 'paste-image' } }

    case 'suspend':
      return { state: s, outcome: { kind: 'suspend' } }

    // Handled in reduceDraftKey; listed so the switch stays exhaustive.
    case 'undo':
    case 'redo':
    case 'stash':
      return { state: s }

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

    case 'transcript':
      // The draft survives the viewer: it is a look back, not an edit.
      return { state: s, outcome: { kind: 'transcript' } }

    case 'cycle-thoughts':
      return { state: s, outcome: { kind: 'cycle-thoughts' } }

    case 'page-up':
    case 'page-down':
      return { state: s }
  }
}

/** Display rows plus the cursor's position within them. */
export interface EditorView {
  rows: string[]
  cursorRow: number
  cursorCol: number
}

/** Hard-split into chunks of at most `width` columns (a wide char or emoji sequence never split). */
function splitToWidth(s: string, width: number): string[] {
  const out: string[] = []
  let cur = ''
  let w = 0
  for (const ch of graphemes(s)) {
    const cw = clusterWidth(ch)
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
 * A wrapped chunk of a line, starting at string offset `at` in it, with the parts
 * inside `marks` emphasized. A mark split by the wrap is painted on both rows.
 */
function markChunk(
  chunk: string,
  at: number,
  marks: ReadonlyArray<{ start: number; end: number }>,
  paint: Painter
): string {
  let out = ''
  let pos = 0
  for (const m of marks) {
    const from = Math.max(m.start - at, pos)
    const to = Math.min(m.end - at, chunk.length)
    if (to <= from) continue
    out += chunk.slice(pos, from) + paint(chunk.slice(from, to), 'bold', 'magenta')
    pos = to
  }
  return out + chunk.slice(pos)
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
    /**
     * Per buffer line, the `[start, end)` ranges (in string offsets) to draw
     * emphasized. Styling only: wrapping and the cursor are computed from the plain
     * text, so a marked draft lays out exactly as an unmarked one.
     */
    marks?: ReadonlyArray<ReadonlyArray<{ start: number; end: number }>>
  }
): EditorView {
  const width = Math.max(8, opts.width)
  if (s.search) {
    const hit = (s.search.index !== null ? s.history[s.search.index] : '') ?? ''
    // One row, never wider than the screen: the redraw counts this as a single row,
    // so a hit that wrapped (a long prompt, or a multi-line one with its newlines)
    // left copies of itself behind on every keystroke. A long query keeps its end.
    const query = truncateVisibleStart(s.search.query, Math.max(1, width - 24))
    const label = `(reverse-i-search)\`${query}': `
    const [first, ...more] = hit.split(/\r?\n/)
    const shown = truncateVisible(more.length ? `${first} …` : first, Math.max(0, width - visibleWidth(label)))
    const row = opts.paint(label, 'dim') + shown
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
      // Cursor: which chunk holds `col`, and where in it. Walked chunk by chunk rather
      // than divided by the row width: a wide character is never split, so a row of
      // them can hold a column less than the width, and the division then put the
      // cursor ahead of where the text actually wraps.
      let rest = visibleWidth(cpSlice(line, 0, s.col))
      let chunkIndex = 0
      while (chunkIndex < chunks.length - 1 && rest >= visibleWidth(chunks[chunkIndex])) {
        rest -= visibleWidth(chunks[chunkIndex])
        chunkIndex++
      }
      cursorRow = rows.length + chunkIndex
      cursorCol = lead + rest
      // A cursor exactly at the wrap boundary sits at the start of the next row.
      if (cursorCol >= width) {
        cursorRow += 1
        cursorCol = lead
      }
    }
    const lineMarks = opts.marks?.[i] ?? []
    let at = 0
    chunks.forEach((chunk, j) => {
      const prefix = i === 0 && j === 0 ? opts.prompt : j === 0 ? cont : ' '.repeat(lead)
      rows.push(prefix + (lineMarks.length ? markChunk(chunk, at, lineMarks, opts.paint) : chunk))
      at += chunk.length
    })
  })

  // Guarantee a row for a cursor that landed past the last rendered row.
  while (cursorRow >= rows.length) rows.push('')
  // The menu goes after that guard: it must never be mistaken for a buffer line.
  if (opts.below?.length) rows.push(...opts.below)
  return { rows, cursorRow, cursorCol }
}

/** Extensions a pasted or dropped path must end in to be taken as an image. */
const IMAGE_PATH_RE = /\.(png|jpe?g|gif|webp)$/i

/**
 * The paths in a paste that is nothing but image file paths, or null when it is
 * anything else (which then pastes as text, exactly as before).
 *
 * A file dragged onto a terminal arrives as a paste of its path, spelled the way
 * the terminal's shell would want it: quoted ('…' or "…"), with spaces escaped by
 * a backslash, or as a file:// URL. Several files arrive separated by spaces or
 * line breaks. On Windows a backslash is a path separator, never an escape.
 *
 * Pure: whether each path exists is the caller's question (a path that does not
 * name a real file means the paste was text after all).
 */
export function parseImagePaths(text: string, opts: { windows?: boolean } = {}): string[] | null {
  const src = text.trim()
  if (!src) return null
  const tokens: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let started = false
  const cs = [...src]
  for (let i = 0; i < cs.length; i++) {
    const ch = cs[i]
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
      continue
    }
    if (ch === '\\' && !opts.windows && i + 1 < cs.length) {
      cur += cs[++i]
      started = true
      continue
    }
    if (/\s/.test(ch)) {
      if (started) tokens.push(cur)
      cur = ''
      started = false
      continue
    }
    cur += ch
    started = true
  }
  if (quote) return null // an unbalanced quote is prose, not a path
  if (started) tokens.push(cur)
  const paths: string[] = []
  for (const raw of tokens) {
    let p = raw
    if (/^file:\/\//i.test(p)) {
      try {
        p = decodeURIComponent(p.replace(/^file:\/\/(localhost)?/i, ''))
      } catch {
        return null
      }
      // file:///C:/x.png on Windows.
      if (opts.windows) p = p.replace(/^\/([A-Za-z]:)/, '$1')
    }
    if (!p || !IMAGE_PATH_RE.test(p)) return null
    paths.push(p)
  }
  return paths.length ? paths : null
}
