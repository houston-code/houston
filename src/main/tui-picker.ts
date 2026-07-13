import type { Painter } from './tui'

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
  title: string
  options: PickerOption[]
  /** Allow selecting more than one (checkboxes); commit joins the chosen values. */
  multiSelect?: boolean
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

/** Map a Node readline keypress to a PickerKey, or null to ignore. Pure/testable. */
export function keyToPickerKey(key: {
  name?: string
  sequence?: string
  ctrl?: boolean
}): PickerKey | null {
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
  if (/^[0-9]$/.test(ch)) return { type: 'digit', n: Number(ch) }
  if (ch.length === 1 && ch >= ' ') return { type: 'char' }
  return null
}

export interface PickerState {
  spec: PickerSpec
  cursor: number
  checked: Set<number>
}

export type PickerOutcome =
  | { kind: 'commit'; value: string }
  | { kind: 'type' } // fall back to a typed answer
  | { kind: 'cancel' }

export function initialPickerState(spec: PickerSpec): PickerState {
  return { spec, cursor: 0, checked: new Set() }
}

const wrap = (i: number, len: number): number => ((i % len) + len) % len

/** Compute the committed value for the current selection. */
function commitValue(s: PickerState): string {
  if (s.spec.multiSelect) {
    const picked = s.spec.options.filter((_, i) => s.checked.has(i)).map((o) => o.value)
    // With nothing checked, committing takes the cursor's option (a sensible default).
    return picked.length ? picked.join(', ') : s.spec.options[s.cursor].value
  }
  return s.spec.options[s.cursor].value
}

/**
 * Advance the picker by one key. Returns the next state and, when the interaction
 * is over, an outcome. A printable char yields `type` so the caller can hand off
 * to the existing typed prompt (custom free-text answer).
 */
export function reducePicker(s: PickerState, key: PickerKey): { state: PickerState; outcome?: PickerOutcome } {
  const len = s.spec.options.length
  switch (key.type) {
    case 'up':
      return { state: { ...s, cursor: wrap(s.cursor - 1, len) } }
    case 'down':
      return { state: { ...s, cursor: wrap(s.cursor + 1, len) } }
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
      return { state: s, outcome: { kind: 'commit', value: commitValue(s) } }
    case 'char':
      return { state: s, outcome: { kind: 'type' } }
    case 'cancel':
      return { state: s, outcome: { kind: 'cancel' } }
  }
}

/**
 * Render the picker to an exact array of lines (no cursor-control codes — the
 * adapter owns positioning). The count lets the adapter erase precisely on redraw.
 */
export function renderPicker(s: PickerState, paint: Painter): string[] {
  const lines = [paint(s.spec.title, 'bold')]
  s.spec.options.forEach((o, i) => {
    const pointer = i === s.cursor ? paint('›', 'cyan') : ' '
    const box = s.spec.multiSelect ? (s.checked.has(i) ? '[x] ' : '[ ] ') : ''
    const label = i === s.cursor ? paint(o.label, 'cyan') : o.label
    const desc = o.description ? paint(`  (${o.description})`, 'dim') : ''
    lines.push(`${pointer} ${box}${label}${desc}`)
  })
  const hint = s.spec.multiSelect
    ? '↑/↓ move · space toggle · enter confirm · type for a custom answer · esc cancel'
    : '↑/↓ move · enter confirm · type for a custom answer · esc cancel'
  lines.push(paint(hint, 'dim'))
  return lines
}
