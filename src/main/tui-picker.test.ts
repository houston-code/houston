import { describe, it, expect } from 'vitest'
import { makePainter } from './tui'
import {
  keyToPickerKey,
  initialPickerState,
  reducePicker,
  renderPicker,
  visibleOptions,
  type PickerSpec,
  type PickerState
} from './tui-picker'
import { visibleWidth } from './tui-wrap'

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
  it('in a filterable picker, letters and digits filter and backspace erases', () => {
    const f = { filter: true }
    expect(keyToPickerKey({ name: 'g', sequence: 'g' }, f)).toEqual({ type: 'filter', text: 'g' })
    expect(keyToPickerKey({ name: '5', sequence: '5' }, f)).toEqual({ type: 'filter', text: '5' })
    expect(keyToPickerKey({ name: 'backspace', sequence: '\x7f' }, f)).toEqual({ type: 'erase' })
    // Navigation and the resolving keys mean what they always do.
    expect(keyToPickerKey({ name: 'down' }, f)).toEqual({ type: 'down' })
    expect(keyToPickerKey({ name: 'return' }, f)).toEqual({ type: 'enter' })
    expect(keyToPickerKey({ name: 'escape' }, f)).toEqual({ type: 'cancel' })
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

describe('reducePicker (filterable)', () => {
  const models: PickerSpec = {
    title: 'Model:',
    filterable: true,
    options: [
      { label: 'claude-opus-5.5', value: '0', description: 'Anthropic' },
      { label: 'gpt-6', value: '1', description: 'OpenAI' },
      { label: 'claude-sonnet-5.5', value: '2', description: 'Anthropic' },
      { label: 'gpt-6-mini', value: '3', description: 'OpenAI' }
    ]
  }
  const typed = (text: string) => [...text].map((c) => ({ type: 'filter' as const, text: c }))

  it('narrows the list as you type, on the label or the description, moving to the first match', () => {
    const { s } = drive(initialPickerState(models), typed('GPT'))
    expect(visibleOptions(s)).toEqual([1, 3])
    expect(s.cursor).toBe(1)
    expect(visibleOptions(drive(initialPickerState(models), typed('anthropic')).s)).toEqual([0, 2])
  })
  it('moves among the matches only, and commits the one under the cursor', () => {
    const { outcome } = drive(initialPickerState(models), [...typed('gpt'), { type: 'down' }, { type: 'enter' }])
    expect(outcome).toEqual({ kind: 'commit', value: '3' })
    const { s } = drive(initialPickerState(models), [...typed('gpt'), { type: 'down' }, { type: 'down' }])
    expect(s.cursor).toBe(1) // wrapped within the matches
  })
  it('keeps the cursor on its option while it still matches', () => {
    const { s } = drive(initialPickerState(models), [{ type: 'down' }, { type: 'down' }, ...typed('sonnet')])
    expect(s.cursor).toBe(2)
  })
  it('widens again on backspace', () => {
    const { s } = drive(initialPickerState(models), [...typed('gptx'), { type: 'erase' }])
    expect(s.query).toBe('gpt')
    expect(visibleOptions(s)).toEqual([1, 3])
  })
  it('confirms nothing when nothing matches', () => {
    const { s, outcome } = drive(initialPickerState(models), [...typed('zzz'), { type: 'enter' }])
    expect(visibleOptions(s)).toEqual([])
    expect(outcome).toBeUndefined()
  })
  it('a picker that is not filterable still reads a typed key as a custom answer', () => {
    expect(reducePicker(initialPickerState(spec), { type: 'filter', text: 'a' }).outcome).toEqual({ kind: 'type' })
    expect(visibleOptions(initialPickerState(spec))).toEqual([0, 1, 2])
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
  it('names what Esc does in the footer', () => {
    expect(renderPicker(initialPickerState(spec), paint).at(-1)).toMatch(/esc cancel$/)
    expect(renderPicker(initialPickerState({ ...spec, escLabel: 'deny' }), paint).at(-1)).toMatch(/esc deny$/)
  })
  it('omits the heading line when the title is empty', () => {
    const lines = renderPicker(initialPickerState({ ...spec, title: '' }), paint)
    expect(lines[0]).toContain('› Allow')
    expect(lines).toHaveLength(4) // 3 options + hint, no blank heading row
  })
  it('shows checkboxes in multi-select', () => {
    let s = initialPickerState(multi)
    s = reducePicker(s, { type: 'space' }).state // check A
    const lines = renderPicker(s, paint)
    expect(lines[1]).toContain('[x] A')
    expect(lines[2]).toContain('[ ] B')
  })

  describe('on a screen shorter than the list', () => {
    const long: PickerSpec = {
      title: 'Model:',
      options: Array.from({ length: 40 }, (_, i) => ({ label: `model-${i}`, value: String(i) }))
    }
    const at = (cursor: number) => ({ ...initialPickerState(long), cursor })

    it('shows a window around the cursor that fits the screen, with what it hides', () => {
      const lines = renderPicker(at(20), paint, { rows: 12, columns: 80 })
      // Never taller than the screen less the row the cursor waits on below it: the
      // redraw can't move up past the top of the screen.
      expect(lines.length).toBeLessThanOrEqual(11)
      expect(lines.some((l) => l.includes('› model-20'))).toBe(true)
      const above = lines.find((l) => /↑ \d+ more/.test(l))
      const below = lines.find((l) => /↓ \d+ more/.test(l))
      const shown = lines.filter((l) => /model-\d+/.test(l)).length
      expect(Number(/(\d+) more/.exec(above!)?.[1]) + shown + Number(/(\d+) more/.exec(below!)?.[1])).toBe(40)
      expect(lines.at(-1)).toContain('enter confirm')
    })

    it('stays in the list at either end', () => {
      const top = renderPicker(at(0), paint, { rows: 12, columns: 80 })
      expect(top.some((l) => /↑ \d+ more/.test(l))).toBe(false)
      expect(top[1]).toContain('› model-0')
      const bottom = renderPicker(at(39), paint, { rows: 12, columns: 80 })
      expect(bottom.some((l) => /↓ \d+ more/.test(l))).toBe(false)
      expect(bottom.at(-2)).toContain('› model-39')
    })

    it('shows every option when they fit, or when the screen size is unknown', () => {
      expect(renderPicker(initialPickerState(spec), paint, { rows: 12, columns: 80 })).toHaveLength(5)
      expect(renderPicker(at(20), paint)).toHaveLength(42)
    })

    it('cuts an option row to the width so each takes one row', () => {
      const wide = initialPickerState({
        title: '',
        options: [{ label: 'a-model', value: 'a', description: 'a description far longer than the screen is wide' }]
      })
      const [row] = renderPicker(wide, paint, { rows: 12, columns: 30 })
      expect(visibleWidth(row)).toBeLessThanOrEqual(29)
      expect(row).toContain('a-model')
    })

    it('shows the filter, and says when nothing matches it', () => {
      const s = { ...initialPickerState({ ...long, filterable: true }), query: 'zzz' }
      const lines = renderPicker(s, paint, { rows: 12, columns: 80 })
      expect(lines[0]).toBe('Model: zzz')
      expect(lines).toContain('  (no match)')
      expect(lines.at(-1)).toContain('type to filter')
    })
  })

  describe('empty option list (e.g. an options-less ask_user)', () => {
    const empty = initialPickerState({ title: 'Free text?', options: [] })

    it('does not throw or NaN on navigation/commit', () => {
      expect(() => reducePicker(empty, { type: 'up' })).not.toThrow()
      expect(reducePicker(empty, { type: 'up' }).state.cursor).toBe(0) // not NaN
      expect(reducePicker(empty, { type: 'down' }).state.cursor).toBe(0)
      expect(() => reducePicker(empty, { type: 'enter' })).not.toThrow()
    })

    it('hands off to the typed prompt on enter/char, cancels on esc', () => {
      expect(reducePicker(empty, { type: 'enter' }).outcome).toEqual({ kind: 'type' })
      expect(reducePicker(empty, { type: 'char' }).outcome).toEqual({ kind: 'type' })
      expect(reducePicker(empty, { type: 'cancel' }).outcome).toEqual({ kind: 'cancel' })
    })
  })
})
