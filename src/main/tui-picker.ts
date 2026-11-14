import type { Painter } from './tui'
import { stripControlChars, truncateVisible } from './tui-wrap'

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
  /** Already-painted text shown after the label as is (a row's time, marks, folder). */
  detail?: string
  /** Extra text the live filter matches besides the label (a folder, say). */
  keywords?: string
}

/**
 * A key-bound action inside the picker (rename, delete, a scope toggle). The picker
 * collects its input or confirmation itself, then hands it to `PickerSpec.onAction`.
 */
export interface PickerAction {
  id: string
  /** `ctrl-<letter>`, or one printable character (which acts only while the filter is empty). */
  keys: string[]
  /** Ask for a line of text first, shown inline under the list. */
  input?: { label: string; initial?: (o: PickerOption) => string }
  /** Ask y/N first; the question (the picker adds `[y/N]`). */
  confirm?: (o: PickerOption) => string
  /** Acts without a highlighted row (a scope toggle), so it works on an empty list too. */
  global?: boolean
}

/** What an action asks the caller to do: the row it applies to and any typed text. */
export interface PickerActionRequest {
  id: string
  /** The highlighted option's value; null for a global action with nothing highlighted. */
  value: string | null
  text?: string
  /** The live filter text when the action ran. */
  query: string
}

/** How the picker changes after an action: new rows, a new title, a notice, or closing. */
export interface PickerActionResult {
  options?: PickerOption[]
  title?: string
  hint?: string
  notice?: string
  /** Close the picker with this outcome instead. */
  done?: PickerOutcome
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
   * Typing filters the rows live instead of handing off to a typed answer; Backspace
   * edits the filter and Esc clears it before it cancels.
   */
  filter?: boolean
  /** The filter text to start with. */
  initialQuery?: string
  /**
   * Fetch the rows for a filter text (a content search). Absent: the rows are
   * filtered locally with `filterPickerOptions`.
   */
  onQuery?: (query: string) => PickerOption[]
  /** Digits 1-9 commit that row at once instead of moving the cursor to it. */
  digitCommits?: boolean
  actions?: PickerAction[]
  /** Run an action; absent: the action closes the picker as an `action` outcome. */
  onAction?: (req: PickerActionRequest) => PickerActionResult | Promise<PickerActionResult>
  /** Lines describing the highlighted row, drawn under the list (each cut to the width after). */
  preview?: (o: PickerOption, width: number) => string[]
  /** At most this many rows at once; the window follows the cursor. */
  maxRows?: number
  /** Shown in place of the rows when there are none (or none match the filter). */
  empty?: string
  /** Replaces the default footer hint. */
  hint?: string
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
  // Only from `richKeyToPickerKey` (a filtering or action picker):
  | { type: 'text'; ch: string } // a printable character, kept
  | { type: 'backspace' }
  | { type: 'ctrl'; name: string } // Ctrl-<letter> other than Ctrl-C

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

/**
 * The key mapping for a picker that filters or has actions: printable characters are
 * kept (they edit the filter or an inline prompt), and Backspace and Ctrl-<letter>
 * come through. Everything else maps as `keyToPickerKey` does. Pure/testable.
 */
export function richKeyToPickerKey(key: { name?: string; sequence?: string; ctrl?: boolean }): PickerKey | null {
  if (key.ctrl && key.name && key.name !== 'c' && /^[a-z]$/.test(key.name)) return { type: 'ctrl', name: key.name }
  if (key.name === 'backspace') return { type: 'backspace' }
  const base = keyToPickerKey(key)
  if (base?.type === 'char') return { type: 'text', ch: key.sequence ?? '' }
  return base
}

/** Whether a spec uses the filtering/action features (and so `richKeyToPickerKey`). */
export function isRichPicker(spec: PickerSpec): boolean {
  return Boolean(spec.filter || spec.actions?.length || spec.preview || spec.digitCommits)
}

/** The key mapping that fits this spec. */
export function pickerKeyFor(
  spec: PickerSpec,
  key: { name?: string; sequence?: string; ctrl?: boolean }
): PickerKey | null {
  return isRichPicker(spec) ? richKeyToPickerKey(key) : keyToPickerKey(key)
}

/** An inline prompt the picker is showing in place of its footer. */
export type PickerMode =
  | { kind: 'list' }
  | { kind: 'input'; action: string; value: string | null; text: string }
  | { kind: 'confirm'; action: string; value: string; question: string }

export interface PickerState {
  spec: PickerSpec
  cursor: number
  checked: Set<number>
  /** The live filter text (filtering pickers). */
  query?: string
  mode?: PickerMode
  /** One line of feedback from the last action ("renamed to ..."). */
  notice?: string
}

export type PickerOutcome =
  | { kind: 'commit'; value: string }
  // Fall back to a typed answer. `text` is the answer already typed, when the picker
  // took one (the numbered list a screen reader answers), so the caller asks no again.
  | { kind: 'type'; text?: string }
  | { kind: 'cancel' }
  // An action ran in a picker without `onAction` (the caller performs it).
  | { kind: 'action'; id: string; value: string | null; text?: string }

export function initialPickerState(spec: PickerSpec): PickerState {
  const s: PickerState = { spec, cursor: 0, checked: new Set() }
  if (spec.filter) s.query = spec.initialQuery ?? ''
  return s
}

/**
 * Options whose label (or keywords) contain every word of `query`, case-insensitive.
 * An empty query keeps them all. Pure/testable.
 */
export function filterPickerOptions(options: PickerOption[], query: string): PickerOption[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return options
  return options.filter((o) => {
    const hay = `${o.label} ${o.keywords ?? ''}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}

/** The rows on show: the spec's options, filtered locally unless `onQuery` fetched them. */
export function visibleOptions(s: PickerState): PickerOption[] {
  if (!s.spec.filter || s.spec.onQuery) return s.spec.options
  return filterPickerOptions(s.spec.options, s.query ?? '')
}

// Wrap an index into [0, len); len === 0 (an empty option list) stays at 0 rather
// than producing NaN via `% 0`.
const wrap = (i: number, len: number): number => (len === 0 ? 0 : ((i % len) + len) % len)

/** Compute the committed value for the current selection, '' when there are no options. */
function commitValue(s: PickerState): string {
  const options = visibleOptions(s)
  if (s.spec.multiSelect) {
    const picked = options.filter((_, i) => s.checked.has(i)).map((o) => o.value)
    // With nothing checked, committing takes the cursor's option (a sensible default).
    return picked.length ? picked.join(', ') : (options[s.cursor]?.value ?? '')
  }
  return options[s.cursor]?.value ?? ''
}

/** The reducer's result: the next state, an outcome when it's over, and whether the filter changed. */
export interface PickerStep {
  state: PickerState
  outcome?: PickerOutcome
  /** The filter text changed: a picker with `onQuery` fetches its rows again. */
  requery?: boolean
}

/** Start the action bound to `binding` (a `ctrl-x` name or a character), if any. */
function startAction(s: PickerState, binding: string): PickerStep | null {
  const action = s.spec.actions?.find((a) => a.keys.includes(binding))
  if (!action) return null
  const row = visibleOptions(s)[s.cursor]
  if (!row && !action.global) return { state: { ...s, notice: 'nothing selected' } }
  const value = row?.value ?? null
  const base: PickerState = { ...s, notice: undefined }
  if (action.input) {
    const text = row && action.input.initial ? stripControlChars(action.input.initial(row)) : ''
    return { state: { ...base, mode: { kind: 'input', action: action.id, value, text } } }
  }
  if (action.confirm && row) {
    return {
      state: { ...base, mode: { kind: 'confirm', action: action.id, value: row.value, question: action.confirm(row) } }
    }
  }
  return { state: base, outcome: { kind: 'action', id: action.id, value } }
}

/** Keys while an inline prompt (text input or y/N) is up. */
function reduceMode(s: PickerState, mode: Exclude<PickerMode, { kind: 'list' }>, key: PickerKey): PickerStep {
  const toList = (notice?: string): PickerStep => ({ state: { ...s, mode: { kind: 'list' }, notice } })
  if (mode.kind === 'confirm') {
    if (key.type === 'text' && /^y$/i.test(key.ch)) {
      return { state: { ...s, mode: { kind: 'list' } }, outcome: { kind: 'action', id: mode.action, value: mode.value } }
    }
    return toList('cancelled')
  }
  switch (key.type) {
    case 'text':
      return { state: { ...s, mode: { ...mode, text: mode.text + key.ch } } }
    case 'space':
      return { state: { ...s, mode: { ...mode, text: `${mode.text} ` } } }
    case 'digit':
      return { state: { ...s, mode: { ...mode, text: mode.text + String(key.n) } } }
    case 'backspace':
      return { state: { ...s, mode: { ...mode, text: [...mode.text].slice(0, -1).join('') } } }
    case 'enter':
      return {
        state: { ...s, mode: { kind: 'list' } },
        outcome: { kind: 'action', id: mode.action, value: mode.value, text: mode.text }
      }
    case 'cancel':
      return toList('cancelled')
    default:
      return { state: s }
  }
}

/** Keys for a filtering or action picker (`isRichPicker`). */
function reduceRich(s: PickerState, key: PickerKey): PickerStep {
  if (s.mode && s.mode.kind !== 'list') return reduceMode(s, s.mode, key)
  const len = visibleOptions(s).length
  const query = s.query ?? ''
  const setQuery = (q: string): PickerStep => ({
    state: { ...s, query: q, cursor: 0, notice: undefined },
    requery: true
  })
  switch (key.type) {
    case 'up':
      return { state: { ...s, cursor: wrap(s.cursor - 1, len) } }
    case 'down':
      return { state: { ...s, cursor: wrap(s.cursor + 1, len) } }
    case 'digit': {
      const i = key.n - 1
      if (i < 0 || i >= len) return { state: s }
      if (s.spec.digitCommits) {
        return { state: { ...s, cursor: i }, outcome: { kind: 'commit', value: visibleOptions(s)[i].value } }
      }
      return { state: { ...s, cursor: i } }
    }
    case 'space':
      if (s.spec.multiSelect && len) {
        const checked = new Set(s.checked)
        if (checked.has(s.cursor)) checked.delete(s.cursor)
        else checked.add(s.cursor)
        return { state: { ...s, checked } }
      }
      return s.spec.filter && query ? setQuery(`${query} `) : { state: s }
    case 'ctrl':
      return startAction(s, `ctrl-${key.name}`) ?? { state: s }
    case 'text': {
      if (!query) {
        const started = startAction(s, key.ch)
        if (started) return started
      }
      if (s.spec.filter) return setQuery(query + key.ch)
      return { state: s, outcome: { kind: 'type' } }
    }
    case 'char':
      return s.spec.filter ? { state: s } : { state: s, outcome: { kind: 'type' } }
    case 'backspace':
      return s.spec.filter && query ? setQuery([...query].slice(0, -1).join('')) : { state: s }
    case 'enter':
      if (!len) return { state: s }
      return { state: s, outcome: { kind: 'commit', value: commitValue(s) } }
    case 'cancel':
      if (s.spec.filter && query) return setQuery('')
      return { state: s, outcome: { kind: 'cancel' } }
  }
}

/**
 * Advance the picker by one key. Returns the next state and, when the interaction
 * is over, an outcome. A printable char yields `type` so the caller can hand off
 * to the existing typed prompt (custom free-text answer).
 */
export function reducePicker(s: PickerState, key: PickerKey): PickerStep {
  if (isRichPicker(s.spec)) return reduceRich(s, key)
  const len = s.spec.options.length
  // Nothing to pick from (e.g. an ask_user with no options): there's nothing to
  // commit or navigate, so hand off to the typed prompt on any resolving key and
  // ignore the rest, rather than committing/deref-ing an out-of-range cursor.
  if (len === 0) {
    if (key.type === 'cancel') return { state: s, outcome: { kind: 'cancel' } }
    if (key.type === 'up' || key.type === 'down' || key.type === 'digit' || key.type === 'space') {
      return { state: s }
    }
    return { state: s, outcome: { kind: 'type' } } // enter / char → typed answer
  }
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
    default:
      return { state: s } // text / backspace / ctrl come only from the rich mapping
  }
}

/**
 * The picker as a numbered list, for screen-reader mode: no pointer, no redraw, just
 * lines to read and a number to type. The footer says what each answer does.
 */
export function renderNumberedPicker(spec: PickerSpec): string[] {
  const lines = spec.title ? [spec.title] : []
  spec.options.forEach((o, i) => {
    lines.push(`${i + 1}. ${o.label}${o.description ? ` (${o.description})` : ''}`)
  })
  const how = spec.multiSelect
    ? 'Type the numbers you choose, separated by spaces or commas, then press Enter.'
    : 'Type a number and press Enter.'
  lines.push(`${how} Or type your own answer. Enter on its own: ${spec.escLabel ?? 'cancel'}.`)
  return lines
}

/** What a typed answer to the numbered list means: a pick, a custom answer, or a retry. */
export type NumberedPickResult = PickerOutcome | { kind: 'invalid'; message: string }

export function parseNumberedPick(spec: PickerSpec, answer: string): NumberedPickResult {
  const a = answer.trim()
  if (!a) return { kind: 'cancel' }
  const tokens = a.split(/[\s,]+/).filter(Boolean)
  // Not all numbers: the user typed their own answer (a reason, `y`, free text).
  const n = spec.options.length
  if (n === 0 || !tokens.every((t) => /^\d+$/.test(t))) return { kind: 'type', text: a }
  const range = n === 1 ? 'Type 1' : `Choose 1 to ${n}`
  const bad = tokens.find((t) => Number(t) < 1 || Number(t) > n)
  if (bad !== undefined) return { kind: 'invalid', message: `There is no option ${bad}. ${range}.` }
  if (!spec.multiSelect && tokens.length > 1) return { kind: 'invalid', message: `Choose one option. ${range}.` }
  const picked = [...new Set(tokens.map(Number))].sort((x, y) => x - y)
  return { kind: 'commit', value: picked.map((i) => spec.options[i - 1].value).join(', ') }
}

/**
 * Render the picker to an exact array of lines (no cursor-control codes — the
 * adapter owns positioning). The count lets the adapter erase precisely on redraw.
 */
export function renderPicker(
  s: PickerState,
  paint: Painter,
  size: { width?: number; height?: number } = {}
): string[] {
  if (isRichPicker(s.spec)) return renderRichPicker(s, paint, size)
  const lines = s.spec.title ? [paint(s.spec.title, 'bold')] : []
  s.spec.options.forEach((o, i) => {
    const pointer = i === s.cursor ? paint('›', 'cyan') : ' '
    const box = s.spec.multiSelect ? (s.checked.has(i) ? '[x] ' : '[ ] ') : ''
    const label = i === s.cursor ? paint(o.label, 'cyan') : o.label
    const desc = o.description ? paint(`  (${o.description})`, 'dim') : ''
    lines.push(`${pointer} ${box}${label}${desc}`)
  })
  const esc = `esc ${s.spec.escLabel ?? 'cancel'}`
  const hint = s.spec.multiSelect
    ? `↑/↓ move · space toggle · enter confirm · type for a custom answer · ${esc}`
    : `↑/↓ move · enter confirm · type for a custom answer · ${esc}`
  lines.push(paint(hint, 'dim'))
  return lines
}

/** The default footer for a rich picker, from the keys it has. */
function richHint(s: PickerState): string {
  const parts = ['↑/↓ move', 'enter confirm']
  if (s.spec.digitCommits) parts.push('1-9 open that row')
  if (s.spec.filter) parts.push('type to filter')
  return [...parts, `esc ${s.spec.escLabel ?? 'cancel'}`].join(' · ')
}

/**
 * A ` · `-separated footer broken between its items onto as many lines as it takes
 * to fit `width` (0: one line), so no key is cut off. Pure.
 */
export function wrapHint(hint: string, width: number): string[] {
  const max = width - 1
  if (width <= 0 || [...hint].length <= max) return [hint]
  const lines: string[] = []
  let line = ''
  for (const item of hint.split(' · ')) {
    const next = line ? `${line} · ${item}` : item
    if (line && [...next].length > max) {
      lines.push(line)
      line = item
    } else {
      line = next
    }
  }
  if (line) lines.push(line)
  return lines
}

/** The first row of a `max`-row window that keeps `cursor` in view, centred when it can. */
export function pickerWindowStart(cursor: number, len: number, max: number): number {
  if (len <= max) return 0
  return Math.max(0, Math.min(cursor - Math.floor(max / 2), len - max))
}

/**
 * Render a filtering/action picker: title, filter line, a window of rows, the
 * highlighted row's preview, any notice or inline prompt, and the footer. With a width,
 * every line is cut to it so none wraps; with a height, the rows shrink (then the
 * preview goes) to keep the whole region on screen, since the adapter redraws by
 * moving up, which can't reach past the top of the terminal.
 */
function renderRichPicker(s: PickerState, paint: Painter, size: { width?: number; height?: number }): string[] {
  const width = size.width && size.width > 0 ? size.width : 0
  const options = visibleOptions(s)
  const head: string[] = s.spec.title ? [paint(s.spec.title, 'bold')] : []
  if (s.spec.filter) {
    const q = stripControlChars(s.query ?? '')
    head.push(q ? `${paint('filter:', 'dim')} ${q}${paint('▏', 'cyan')}` : paint('type to filter', 'dim'))
  }
  const tail: string[] = []
  if (s.notice) tail.push(paint(`· ${stripControlChars(s.notice)}`, 'dim'))
  const mode = s.mode ?? { kind: 'list' }
  if (mode.kind === 'input') {
    const label = s.spec.actions?.find((a) => a.id === mode.action)?.input?.label ?? 'text'
    tail.push(`${paint(`${label}:`, 'yellow')} ${stripControlChars(mode.text)}${paint('▏', 'cyan')}`)
    tail.push(paint('enter save · esc cancel', 'dim'))
  } else if (mode.kind === 'confirm') {
    tail.push(paint(`${stripControlChars(mode.question)} [y/N]`, 'yellow'))
  } else {
    for (const l of wrapHint(s.spec.hint ?? richHint(s), width)) tail.push(paint(l, 'dim'))
  }
  const current = options[s.cursor]
  let preview = current && s.spec.preview && mode.kind === 'list' ? s.spec.preview(current, width || 80) : []
  const height = size.height && size.height > 0 ? size.height : 0
  // A row of slack under the region for the cursor, and two for the "more" markers.
  const fixed = head.length + tail.length + 1
  let maxRows = Math.max(1, s.spec.maxRows ?? Math.max(1, options.length))
  if (height) {
    if (height - fixed - preview.length - 2 < Math.min(3, Math.max(1, options.length))) preview = []
    maxRows = Math.max(1, Math.min(maxRows, height - fixed - preview.length - 2))
  }
  const rows: string[] = []
  if (!options.length) {
    rows.push(paint(`  ${s.spec.empty ?? 'nothing to show'}`, 'dim'))
  } else {
    const start = pickerWindowStart(s.cursor, options.length, maxRows)
    const end = Math.min(options.length, start + maxRows)
    if (start > 0) rows.push(paint(`  ↑ ${start} more`, 'dim'))
    for (let i = start; i < end; i++) {
      const o = options[i]
      const on = i === s.cursor
      const pointer = on ? paint('›', 'cyan') : ' '
      const box = s.spec.multiSelect ? (s.checked.has(i) ? '[x] ' : '[ ] ') : ''
      const label = on ? paint(stripControlChars(o.label), 'cyan') : stripControlChars(o.label)
      const desc = o.description ? paint(`  (${stripControlChars(o.description)})`, 'dim') : ''
      rows.push(`${pointer} ${box}${label}${o.detail ?? ''}${desc}`)
    }
    if (end < options.length) rows.push(paint(`  ↓ ${options.length - end} more`, 'dim'))
  }
  const lines = [...head, ...rows, ...preview, ...tail]
  return width ? lines.map((l) => truncateVisible(l, Math.max(1, width - 1))) : lines
}

/**
 * The picker's interactive loop without a terminal: feed it keys, read its lines.
 * It fetches rows through `onQuery` when the filter changes and runs actions through
 * `onAction`, keeping the picker open. The terminal adapter (tui-io.ts) and the tests
 * both drive this, so the scripted path is the real one.
 */
export interface PickerSession {
  lines: (size?: { width?: number; height?: number }) => string[]
  /** Feed one key; resolves with the outcome once the picker is done. */
  press: (key: PickerKey) => Promise<PickerOutcome | undefined>
  state: () => PickerState
}

export function createPickerSession(spec: PickerSpec, paint: Painter): PickerSession {
  let state = initialPickerState(spec)
  const fetchRows = (q: string): void => {
    if (!spec.onQuery) return
    let options: PickerOption[]
    let notice = state.notice
    try {
      options = spec.onQuery(q)
    } catch (e) {
      options = []
      notice = `couldn't search: ${(e as Error).message}`
    }
    state = { ...state, spec: { ...state.spec, options }, cursor: 0, notice }
  }
  if (spec.filter && spec.onQuery && state.query) fetchRows(state.query)
  return {
    state: () => state,
    lines: (size) => renderPicker(state, paint, size),
    press: async (key) => {
      const step = reducePicker(state, key)
      state = step.state
      if (step.requery) fetchRows(state.query ?? '')
      const outcome = step.outcome
      if (outcome?.kind !== 'action' || !spec.onAction) return outcome
      let result: PickerActionResult
      try {
        result = await spec.onAction({
          id: outcome.id,
          value: outcome.value,
          ...(outcome.text !== undefined ? { text: outcome.text } : {}),
          query: state.query ?? ''
        })
      } catch (e) {
        state = { ...state, notice: `that didn't work: ${(e as Error).message}` }
        return undefined
      }
      if (result.done) return result.done
      const keep = visibleOptions(state)[state.cursor]?.value
      let next: PickerState = { ...state, notice: result.notice }
      if (result.options || result.title !== undefined || result.hint !== undefined) {
        next = {
          ...next,
          checked: new Set(),
          spec: {
            ...next.spec,
            ...(result.options ? { options: result.options } : {}),
            ...(result.title !== undefined ? { title: result.title } : {}),
            ...(result.hint !== undefined ? { hint: result.hint } : {})
          }
        }
      }
      // Stay on the same row when it is still there, else the nearest one.
      const rows = visibleOptions(next)
      const at = rows.findIndex((o) => o.value === keep)
      next.cursor = at >= 0 ? at : Math.max(0, Math.min(next.cursor, rows.length - 1))
      state = next
      return undefined
    }
  }
}

/**
 * Run a picker to completion on scripted keys, recording each frame; running out of
 * keys cancels. For tests (the fake terminal's `select`).
 */
export async function drivePicker(
  spec: PickerSpec,
  keys: PickerKey[],
  paint: Painter,
  size: { width?: number; height?: number } = { width: 100 }
): Promise<{ outcome: PickerOutcome; frames: string[][] }> {
  const session = createPickerSession(spec, paint)
  const frames = [session.lines(size)]
  for (const key of keys) {
    const outcome = await session.press(key)
    frames.push(session.lines(size))
    if (outcome) return { outcome, frames }
  }
  return { outcome: { kind: 'cancel' }, frames }
}
