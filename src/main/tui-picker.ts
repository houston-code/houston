import type { Painter } from './tui'
import { truncateVisible, visibleWidth } from './tui-wrap'

/**
 * Arrow-key selectable picker for tool approvals and `ask_user` questions — the
 * first stage of the raw-mode input layer. The model + view are PURE (this file);
 * the terminal specifics (transient raw mode, keypress decoding, region redraw)
 * live in tui-io.ts behind the `TuiIo.select` seam, so the driver stays testable
 * and falls back to the existing typed prompt when a picker isn't available.
 *
 * Rendering follows the same single-region-redraw discipline as the spinner: the
 * view emits an exact array of lines, and the adapter erases exactly those lines
 * before redrawing — never a full-screen clear — so it stays tear-free.
 */

/** A selectable option. `value` is what commits; `label` is shown. */
export interface PickerOption {
  label: string
  value: string
  description?: string
}

export interface PickerSpec {
  /** Heading line above the options; empty when the caller already printed the question. */
  title: string
  options: PickerOption[]
  /** Allow selecting more than one (checkboxes); commit joins the chosen values. */
  multiSelect?: boolean
  /** What Esc does here, for the footer ("esc deny" at an approval). Default "cancel". */
  escLabel?: string
  /**
   * Typing narrows the list to the options whose label or description holds what was
   * typed, instead of switching to a typed answer. For long lists of names (the model
   * picker); a picker whose letters mean something else leaves it off.
   */
  filterable?: boolean
}

/** Semantic key events the picker understands (adapter maps real keys to these). */
export type PickerKey =
  | { type: 'up' }
  | { type: 'down' }
  | { type: 'enter' }
  | { type: 'space' }
  | { type: 'digit'; n: number }
  | { type: 'char' } // any other printable key → the user wants to type a custom answer
  | { type: 'cancel' } // Esc / Ctrl-C
  | { type: 'filter'; text: string } // a printable key in a filterable picker
  | { type: 'erase' } // backspace in a filterable picker

/**
 * Map a Node readline keypress to a PickerKey, or null to ignore. Pure/testable.
 * With `filter` on (a filterable picker), printable keys and digits narrow the list
 * and backspace widens it again.
 */
export function keyToPickerKey(
  key: {
    name?: string
    sequence?: string
    ctrl?: boolean
  },
  opts: { filter?: boolean } = {}
): PickerKey | null {
  if (key.ctrl && key.name === 'c') return { type: 'cancel' }
  switch (key.name) {
    case 'up':
      return { type: 'up' }
    case 'down':
      return { type: 'down' }
    case 'return':
    case 'enter':
      return { type: 'enter' }
    case 'space':
      return { type: 'space' }
    case 'escape':
      return { type: 'cancel' }
  }
  const ch = key.sequence ?? ''
  if (opts.filter) {
    if (key.name === 'backspace') return { type: 'erase' }
    if (ch.length === 1 && ch > ' ' && ch !== '\x7f') return { type: 'filter', text: ch }
  }
  if (/^[0-9]$/.test(ch)) return { type: 'digit', n: Number(ch) }
  if (ch.length === 1 && ch >= ' ') return { type: 'char' }
  return null
}

export interface PickerState {
  spec: PickerSpec
  cursor: number
  checked: Set<number>
  /** What has been typed into a filterable picker (absent or '' shows every option). */
  query?: string
}

export type PickerOutcome =
  | { kind: 'commit'; value: string }
  | { kind: 'type' } // fall back to a typed answer
  | { kind: 'cancel' }

export function initialPickerState(spec: PickerSpec): PickerState {
  return { spec, cursor: 0, checked: new Set() }
}

// Wrap an index into [0, len); len === 0 (an empty option list) stays at 0 rather
// than producing NaN via `% 0`.
const wrap = (i: number, len: number): number => (len === 0 ? 0 : ((i % len) + len) % len)

/**
 * The options on show, as indices into the spec's list: all of them, or in a
 * filterable picker the ones whose label or description holds the query (any case).
 */
export function visibleOptions(s: PickerState): number[] {
  const all = s.spec.options.map((_, i) => i)
  const q = s.spec.filterable ? (s.query ?? '').toLowerCase() : ''
  if (!q) return all
  return all.filter((i) => {
    const o = s.spec.options[i]
    return `${o.label} ${o.description ?? ''}`.toLowerCase().includes(q)
  })
}

/** The cursor moved `by` among the options on show, wrapping at the ends. */
function step(s: PickerState, by: number): number {
  const shown = visibleOptions(s)
  const at = shown.indexOf(s.cursor)
  if (at < 0) return shown[0] ?? s.cursor
  return shown[wrap(at + by, shown.length)]
}

/** Compute the committed value for the current selection, '' when there are no options. */
function commitValue(s: PickerState): string {
  if (s.spec.multiSelect) {
    const picked = s.spec.options.filter((_, i) => s.checked.has(i)).map((o) => o.value)
    // With nothing checked, committing takes the cursor's option (a sensible default).
    return picked.length ? picked.join(', ') : (s.spec.options[s.cursor]?.value ?? '')
  }
  return s.spec.options[s.cursor]?.value ?? ''
}

/**
 * Advance the picker by one key. Returns the next state and, when the interaction
 * is over, an outcome. A printable char yields `type` so the caller can hand off
 * to the existing typed prompt (custom free-text answer).
 */
export function reducePicker(s: PickerState, key: PickerKey): { state: PickerState; outcome?: PickerOutcome } {
  const len = s.spec.options.length
  // Nothing to pick from (e.g. an ask_user with no options): there's nothing to
  // commit or navigate, so hand off to the typed prompt on any resolving key and
  // ignore the rest, rather than committing/deref-ing an out-of-range cursor.
  if (len === 0) {
    if (key.type === 'cancel') return { state: s, outcome: { kind: 'cancel' } }
    if (
      key.type === 'up' ||
      key.type === 'down' ||
      key.type === 'digit' ||
      key.type === 'space' ||
      key.type === 'erase'
    ) {
      return { state: s }
    }
    return { state: s, outcome: { kind: 'type' } } // enter / char → typed answer
  }
  switch (key.type) {
    case 'up':
      return { state: { ...s, cursor: step(s, -1) } }
    case 'down':
      return { state: { ...s, cursor: step(s, 1) } }
    case 'filter':
    case 'erase': {
      // Only a filterable picker reads a typed key as a filter; elsewhere a printable
      // key still means "let me type my own answer".
      if (!s.spec.filterable) return key.type === 'filter' ? { state: s, outcome: { kind: 'type' } } : { state: s }
      const query = key.type === 'filter' ? `${s.query ?? ''}${key.text}` : [...(s.query ?? '')].slice(0, -1).join('')
      const next = { ...s, query }
      const shown = visibleOptions(next)
      // The cursor stays on its option while that still matches, else the first match.
      return { state: { ...next, cursor: shown.includes(s.cursor) ? s.cursor : (shown[0] ?? s.cursor) } }
    }
    case 'digit': {
      const i = key.n - 1
      if (i >= 0 && i < len) return { state: { ...s, cursor: i } }
      return { state: s }
    }
    case 'space': {
      if (!s.spec.multiSelect) return { state: s }
      const checked = new Set(s.checked)
      if (checked.has(s.cursor)) checked.delete(s.cursor)
      else checked.add(s.cursor)
      return { state: { ...s, checked } }
    }
    case 'enter':
      // A filter that matches nothing has nothing to confirm.
      if (!visibleOptions(s).length) return { state: s }
      return { state: s, outcome: { kind: 'commit', value: commitValue(s) } }
    case 'char':
      return { state: s, outcome: { kind: 'type' } }
    case 'cancel':
      return { state: s, outcome: { kind: 'cancel' } }
  }
}

/** The terminal the picker is drawn in; absent or 0 means unknown. */
export interface PickerScreen {
  /** Rows: a list taller than the screen shows a window of it around the cursor. */
  rows?: number
  /** Columns: each option row is cut to fit on one row. */
  columns?: number
}

/**
 * Render the picker to an exact array of lines (no cursor-control codes — the
 * adapter owns positioning). The count lets the adapter erase precisely on redraw.
 *
 * The redraw moves the cursor up over the picker, and the cursor can't move above
 * the top of the screen: a list taller than the screen left a copy of its top in
 * the scrollback on every arrow press. So given the screen, a long list shows the
 * options around the cursor, with how many are hidden above and below.
 */
export function renderPicker(s: PickerState, paint: Painter, screen: PickerScreen = {}): string[] {
  const query = s.spec.filterable ? (s.query ?? '') : ''
  const head = [s.spec.title ? paint(s.spec.title, 'bold') : '', query].filter(Boolean).join(' ')
  const lines = head ? [head] : []
  const esc = `esc ${s.spec.escLabel ?? 'cancel'}`
  const typing = s.spec.filterable ? 'type to filter' : 'type for a custom answer'
  const hint = paint(
    s.spec.multiSelect
      ? `↑/↓ move · space toggle · enter confirm · ${typing} · ${esc}`
      : `↑/↓ move · enter confirm · ${typing} · ${esc}`,
    'dim'
  )
  const cols = screen.columns ?? 0
  // One column spare, as the composer keeps: a row that fills the last column makes
  // some terminals wrap early.
  const fit = (line: string): string => (cols > 1 ? truncateVisible(line, cols - 1) : line)
  const rowsOf = (line: string): number => (cols > 0 ? Math.max(1, Math.ceil(visibleWidth(line) / cols)) : 1)

  const shown = visibleOptions(s)
  // Room for options: the screen less the heading, the footer, and the row the
  // cursor waits on under the picker.
  const room = screen.rows ? screen.rows - lines.reduce((n, l) => n + rowsOf(l), 0) - rowsOf(hint) - 1 : Infinity
  let from = 0
  let to = shown.length
  if (shown.length > room) {
    const size = Math.max(1, room - 2) // less the "more" rows above and below
    const at = Math.max(0, shown.indexOf(s.cursor))
    from = Math.min(Math.max(0, at - Math.floor(size / 2)), shown.length - size)
    to = from + size
  }
  if (from > 0) lines.push(paint(`  ↑ ${from} more`, 'dim'))
  for (const i of shown.slice(from, to)) {
    const o = s.spec.options[i]
    const pointer = i === s.cursor ? paint('›', 'cyan') : ' '
    const box = s.spec.multiSelect ? (s.checked.has(i) ? '[x] ' : '[ ] ') : ''
    const label = i === s.cursor ? paint(o.label, 'cyan') : o.label
    const desc = o.description ? paint(`  (${o.description})`, 'dim') : ''
    lines.push(fit(`${pointer} ${box}${label}${desc}`))
  }
  if (to < shown.length) lines.push(paint(`  ↓ ${shown.length - to} more`, 'dim'))
  if (!shown.length && s.spec.options.length) lines.push(paint('  (no match)', 'dim'))
  lines.push(hint)
  return lines
}
