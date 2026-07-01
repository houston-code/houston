import { describe, it, expect } from 'vitest'
import { makePainter } from './tui'
import {
  keyToPickerKey,
  initialPickerState,
  reducePicker,
  renderPicker,
  type PickerSpec,
  type PickerState
} from './tui-picker'

const spec: PickerSpec = {
  title: 'Approve run_shell?',
  options: [
    { label: 'Allow', value: 'allow' },
    { label: 'Deny', value: 'deny' },
    { label: 'Always allow this kind', value: 'always' }
  ]
}
const multi: PickerSpec = {
  title: 'Which?',
  multiSelect: true,
  options: [
    { label: 'A', value: 'A' },
    { label: 'B', value: 'B' },
    { label: 'C', value: 'C' }
  ]
}

describe('keyToPickerKey', () => {
  it('maps arrows, enter, space, escape, ctrl-c', () => {
    expect(keyToPickerKey({ name: 'up' })).toEqual({ type: 'up' })
    expect(keyToPickerKey({ name: 'down' })).toEqual({ type: 'down' })
    expect(keyToPickerKey({ name: 'return' })).toEqual({ type: 'enter' })
    expect(keyToPickerKey({ name: 'space' })).toEqual({ type: 'space' })
    expect(keyToPickerKey({ name: 'escape' })).toEqual({ type: 'cancel' })
    expect(keyToPickerKey({ name: 'c', ctrl: true })).toEqual({ type: 'cancel' })
  })
  it('maps digits and printable chars', () => {
    expect(keyToPickerKey({ name: '2', sequence: '2' })).toEqual({ type: 'digit', n: 2 })
    expect(keyToPickerKey({ sequence: 'x' })).toEqual({ type: 'char' })
  })
  it('ignores non-printable / unknown keys', () => {
    expect(keyToPickerKey({ sequence: '\t' })).toBeNull()
    expect(keyToPickerKey({ name: 'f5' })).toBeNull()
  })
})

const drive = (s0: PickerState, keys: Parameters<typeof reducePicker>[1][]) => {
  let s = s0
  let outcome
  for (const k of keys) {
    const r = reducePicker(s, k)
    s = r.state
    if (r.outcome) outcome = r.outcome
  }
  return { s, outcome }
}

describe('reducePicker (single-select)', () => {
  it('moves the cursor with wrap and commits the value', () => {
    const { outcome } = drive(initialPickerState(spec), [{ type: 'down' }, { type: 'enter' }])
    expect(outcome).toEqual({ kind: 'commit', value: 'deny' })
  })
  it('wraps past the top', () => {
    const { s } = drive(initialPickerState(spec), [{ type: 'up' }])
    expect(s.cursor).toBe(2) // wrapped to last
  })
  it('a digit jumps to that option', () => {
    const { s } = drive(initialPickerState(spec), [{ type: 'digit', n: 3 }])
    expect(s.cursor).toBe(2)
    const { s: s2 } = drive(initialPickerState(spec), [{ type: 'digit', n: 9 }])
    expect(s2.cursor).toBe(0) // out of range: no move
  })
  it('a printable char requests typed fallback', () => {
    const { outcome } = drive(initialPickerState(spec), [{ type: 'char' }])
    expect(outcome).toEqual({ kind: 'type' })
  })
  it('cancel returns cancel', () => {
    const { outcome } = drive(initialPickerState(spec), [{ type: 'cancel' }])
    expect(outcome).toEqual({ kind: 'cancel' })
  })
  it('space is a no-op in single-select', () => {
    const { s } = drive(initialPickerState(spec), [{ type: 'space' }])
    expect(s.checked.size).toBe(0)
  })
})

describe('reducePicker (multi-select)', () => {
  it('toggles checkboxes and commits joined values', () => {
    const { outcome } = drive(initialPickerState(multi), [
      { type: 'space' }, // check A
      { type: 'down' },
      { type: 'down' },
      { type: 'space' }, // check C
      { type: 'enter' }
    ])
    expect(outcome).toEqual({ kind: 'commit', value: 'A, C' })
  })
  it('commits the cursor option when nothing is checked', () => {
    const { outcome } = drive(initialPickerState(multi), [{ type: 'down' }, { type: 'enter' }])
    expect(outcome).toEqual({ kind: 'commit', value: 'B' })
  })
  it('space toggles off again', () => {
    const { s } = drive(initialPickerState(multi), [{ type: 'space' }, { type: 'space' }])
    expect(s.checked.has(0)).toBe(false)
  })
})

describe('renderPicker', () => {
  const paint = makePainter(false)
  it('marks the cursor and lists options + a hint', () => {
    const lines = renderPicker(initialPickerState(spec), paint)
    expect(lines[0]).toContain('Approve run_shell?')
    expect(lines[1]).toContain('› Allow') // cursor on first
    expect(lines[2]).toContain('Deny')
    expect(lines.at(-1)).toContain('enter confirm')
    // Exactly title + 3 options + hint.
    expect(lines).toHaveLength(5)
  })
  it('shows checkboxes in multi-select', () => {
    let s = initialPickerState(multi)
    s = reducePicker(s, { type: 'space' }).state // check A
    const lines = renderPicker(s, paint)
    expect(lines[1]).toContain('[x] A')
    expect(lines[2]).toContain('[ ] B')
  })
})
