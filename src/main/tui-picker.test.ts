import { describe, it, expect } from 'vitest'
import { makePainter } from './tui'
import {
  keyToPickerKey,
  initialPickerState,
  reducePicker,
  renderPicker,
  richKeyToPickerKey,
  pickerKeyFor,
  filterPickerOptions,
  pickerWindowStart,
  wrapHint,
  createPickerSession,
  drivePicker,
  type PickerKey,
  renderNumberedPicker,
  parseNumberedPick,
  NOTHING_TICKED_NOTICE,
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
    // Ctrl-C is not Esc: it stops the run, where Esc only answers the picker.
    expect(keyToPickerKey({ name: 'c', ctrl: true })).toEqual({ type: 'interrupt' })
  })
  it('maps digits and printable chars, keeping the char', () => {
    expect(keyToPickerKey({ name: '2', sequence: '2' })).toEqual({ type: 'digit', n: 2 })
    expect(keyToPickerKey({ sequence: 'x' })).toEqual({ type: 'char', ch: 'x' })
    expect(keyToPickerKey({ sequence: '!' })).toEqual({ type: 'char', ch: '!' })
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
  it('a printable char requests typed fallback, carrying the char', () => {
    const { outcome } = drive(initialPickerState(spec), [{ type: 'char', ch: 'u' }])
    expect(outcome).toEqual({ kind: 'type', seed: 'u' })
  })
  it('cancel returns cancel', () => {
    const { outcome } = drive(initialPickerState(spec), [{ type: 'cancel' }])
    expect(outcome).toEqual({ kind: 'cancel' })
  })
  it('an interrupt is its own outcome, not a cancel', () => {
    expect(drive(initialPickerState(spec), [{ type: 'interrupt' }]).outcome).toEqual({ kind: 'interrupt' })
    expect(reducePicker(initialPickerState({ title: '', options: [] }), { type: 'interrupt' }).outcome).toEqual({
      kind: 'interrupt'
    })
  })
})

describe('reducePicker (option keys)', () => {
  const keyed: PickerSpec = {
    title: '',
    options: [
      { label: 'Allow', value: 'allow', key: 'y' },
      { label: 'Always allow', value: 'rule-allow', key: '!' },
      { label: 'Deny with a reason…', value: 'deny-note' },
      { label: 'Deny', value: 'deny', key: 'n' }
    ]
  }
  it("commits an option's key at once, whatever the cursor is on", () => {
    expect(drive(initialPickerState(keyed), [{ type: 'down' }, { type: 'char', ch: 'y' }]).outcome).toEqual({
      kind: 'commit',
      value: 'allow'
    })
    expect(drive(initialPickerState(keyed), [{ type: 'char', ch: 'N' }]).outcome).toEqual({ kind: 'commit', value: 'deny' })
    expect(drive(initialPickerState(keyed), [{ type: 'char', ch: '!' }]).outcome).toEqual({
      kind: 'commit',
      value: 'rule-allow'
    })
  })
  it('hands any other key to the typed answer as its first character', () => {
    expect(drive(initialPickerState(keyed), [{ type: 'char', ch: 'u' }]).outcome).toEqual({ kind: 'type', seed: 'u' })
  })
  it('ignores a key that picks nothing when there is no typed answer', () => {
    const { s, outcome } = drive(initialPickerState({ ...keyed, typeLabel: null }), [{ type: 'char', ch: 'u' }])
    expect(outcome).toBeUndefined()
    expect(s.cursor).toBe(0)
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
  it('does not send the highlighted option when nothing is ticked, and says how to tick', () => {
    const { s, outcome } = drive(initialPickerState(multi), [{ type: 'down' }, { type: 'enter' }])
    expect(outcome).toBeUndefined()
    expect(s.notice).toBe(NOTHING_TICKED_NOTICE)
    expect(renderPicker(s, makePainter(false)).join('\n')).toContain('press space to tick')
    // Ticking clears the notice, and Enter then sends what was ticked.
    const next = drive(s, [{ type: 'space' }, { type: 'enter' }])
    expect(next.outcome).toEqual({ kind: 'commit', value: 'B' })
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
  it('shows option keys beside the labels and says what typing does', () => {
    const lines = renderPicker(
      initialPickerState({
        title: '',
        escLabel: 'deny',
        typeLabel: 'type a reason to deny',
        options: [
          { label: 'Allow', value: 'allow', key: 'y' },
          { label: 'Deny with a reason…', value: 'deny-note' }
        ]
      }),
      paint
    )
    expect(lines[0]).toBe('› y  Allow')
    expect(lines[1]).toBe('     Deny with a reason…')
    expect(lines.at(-1)).toBe('↑/↓ move · enter or its key confirms · type a reason to deny · esc deny')
    // No typed answer: the footer doesn't offer one.
    const plan = renderPicker(initialPickerState({ ...spec, typeLabel: null }), paint).at(-1)
    expect(plan).toBe('↑/↓ move · enter confirm · esc cancel')
    expect(renderPicker(initialPickerState(spec), paint).at(-1)).toContain('type for a custom answer')
  })
  it('omits the heading line when the title is empty', () => {
    const lines = renderPicker(initialPickerState({ ...spec, title: '' }), paint)
    expect(lines[0]).toContain('› Allow')
    expect(lines).toHaveLength(4) // 3 options + hint, no blank heading row
  })
  it('windows a plain list taller than the screen, and leaves one that fits as it was', () => {
    const long: PickerSpec = {
      title: 'Which?',
      options: Array.from({ length: 40 }, (_, i) => ({ label: `opt-${i}`, value: String(i) }))
    }
    const at = (cursor: number) => renderPicker({ ...initialPickerState(long), cursor }, paint, { width: 80, height: 12 })
    for (const c of [0, 20, 39]) {
      const lines = at(c)
      expect(lines.length).toBeLessThanOrEqual(11) // one row spare for the cursor under it
      expect(lines.some((l) => l.includes(`› opt-${c}`))).toBe(true)
    }
    const mid = at(20)
    const shown = mid.filter((l) => /opt-\d+/.test(l)).length
    const count = (re: RegExp) => Number(mid.find((l) => re.test(l))?.match(/(\d+) more/)?.[1])
    expect(count(/↑ \d+ more/) + shown + count(/↓ \d+ more/)).toBe(40)
    expect(at(0).some((l) => /↑ \d+ more/.test(l))).toBe(false)
    expect(at(39).some((l) => /↓ \d+ more/.test(l))).toBe(false)
    // Short enough for the screen: exactly the unsized rendering.
    expect(renderPicker(initialPickerState(spec), paint, { width: 80, height: 12 })).toEqual(
      renderPicker(initialPickerState(spec), paint)
    )
  })

  it('shows checkboxes in multi-select', () => {
    let s = initialPickerState(multi)
    s = reducePicker(s, { type: 'space' }).state // check A
    const lines = renderPicker(s, paint)
    expect(lines[1]).toContain('[x] A')
    expect(lines[2]).toContain('[ ] B')
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
      expect(reducePicker(empty, { type: 'char', ch: 'h' }).outcome).toEqual({ kind: 'type', seed: 'h' })
      expect(reducePicker(empty, { type: 'cancel' }).outcome).toEqual({ kind: 'cancel' })
    })
  })
})

describe('filtering and action pickers', () => {
  const paint = makePainter(false)
  const rows = [
    { label: 'Auth refactor', value: 'a', keywords: '~/work/api' },
    { label: 'CSS tweaks', value: 'b' },
    { label: 'Auth tests', value: 'c' }
  ]
  const text = (s: string): PickerKey[] => [...s].map((ch) => ({ type: 'text', ch }))
  const rich: PickerSpec = {
    title: 'Pick',
    options: rows,
    filter: true,
    digitCommits: true,
    actions: [
      { id: 'rename', keys: ['ctrl-r'], input: { label: 'new title', initial: (o) => o.label } },
      { id: 'delete', keys: ['ctrl-d', 'x'], confirm: (o) => `Delete ${o.label}?` },
      { id: 'scope', keys: ['ctrl-a'], global: true }
    ]
  }

  it('maps keys for rich pickers, leaving plain pickers as they were', () => {
    expect(richKeyToPickerKey({ sequence: 'x' })).toEqual({ type: 'text', ch: 'x' })
    expect(richKeyToPickerKey({ name: 'backspace', sequence: '\x7f' })).toEqual({ type: 'backspace' })
    expect(richKeyToPickerKey({ name: 'r', ctrl: true, sequence: '\x12' })).toEqual({ type: 'ctrl', name: 'r' })
    // Ctrl-C stops the run, where Esc only cancels the picker.
    expect(richKeyToPickerKey({ name: 'c', ctrl: true })).toEqual({ type: 'interrupt' })
    expect(richKeyToPickerKey({ name: '3', sequence: '3' })).toEqual({ type: 'digit', n: 3 })
    expect(pickerKeyFor(spec, { sequence: 'x' })).toEqual({ type: 'char', ch: 'x' })
    expect(pickerKeyFor(spec, { name: 'backspace' })).toBeNull()
    expect(pickerKeyFor(rich, { sequence: 'x' })).toEqual({ type: 'text', ch: 'x' })
  })

  it('filters on every word, across label and keywords, case-insensitively', () => {
    expect(filterPickerOptions(rows, '').map((o) => o.value)).toEqual(['a', 'b', 'c'])
    expect(filterPickerOptions(rows, 'AUTH').map((o) => o.value)).toEqual(['a', 'c'])
    expect(filterPickerOptions(rows, 'auth api').map((o) => o.value)).toEqual(['a'])
    expect(filterPickerOptions(rows, 'nope')).toEqual([])
  })

  it('typing narrows the rows live; Backspace widens; Esc clears, then cancels', () => {
    let s = initialPickerState(rich)
    for (const k of text('tes')) s = reducePicker(s, k).state
    expect(s.query).toBe('tes')
    expect(renderPicker(s, paint).join('\n')).toContain('› Auth tests')
    expect(renderPicker(s, paint).join('\n')).not.toContain('CSS')
    s = reducePicker(s, { type: 'backspace' }).state
    expect(s.query).toBe('te')
    const cleared = reducePicker(s, { type: 'cancel' })
    expect(cleared.outcome).toBeUndefined()
    expect(cleared.state.query).toBe('')
    expect(reducePicker(cleared.state, { type: 'cancel' }).outcome).toEqual({ kind: 'cancel' })
  })

  it('a digit commits that visible row; Enter on no rows does nothing', () => {
    let s = initialPickerState(rich)
    for (const k of text('auth')) s = reducePicker(s, k).state
    expect(reducePicker(s, { type: 'digit', n: 2 }).outcome).toEqual({ kind: 'commit', value: 'c' })
    expect(reducePicker(s, { type: 'digit', n: 9 }).outcome).toBeUndefined()
    for (const k of text('zzz')) s = reducePicker(s, k).state
    expect(reducePicker(s, { type: 'enter' }).outcome).toBeUndefined()
    expect(renderPicker(s, paint).join('\n')).toContain('nothing to show')
  })

  it('an input action collects text inline, then reports it', () => {
    let s = reducePicker(initialPickerState(rich), { type: 'ctrl', name: 'r' }).state
    expect(s.mode).toEqual({ kind: 'input', action: 'rename', value: 'a', text: 'Auth refactor' })
    expect(renderPicker(s, paint).join('\n')).toContain('new title: Auth refactor▏')
    s = reducePicker(s, { type: 'backspace' }).state
    for (const k of [...text('!'), { type: 'space' } as PickerKey, { type: 'digit', n: 2 } as PickerKey]) {
      s = reducePicker(s, k).state
    }
    expect(reducePicker(s, { type: 'enter' }).outcome).toEqual({
      kind: 'action',
      id: 'rename',
      value: 'a',
      text: 'Auth refacto! 2'
    })
    const cancelled = reducePicker(s, { type: 'cancel' }).state
    expect(cancelled.mode).toEqual({ kind: 'list' })
    expect(cancelled.notice).toBe('cancelled')
  })

  it('a confirm action needs y', () => {
    const asked = reducePicker(initialPickerState(rich), { type: 'ctrl', name: 'd' }).state
    expect(renderPicker(asked, paint).join('\n')).toContain('Delete Auth refactor? [y/N]')
    expect(reducePicker(asked, { type: 'text', ch: 'Y' }).outcome).toEqual({ kind: 'action', id: 'delete', value: 'a' })
    expect(reducePicker(asked, { type: 'enter' }).state.mode).toEqual({ kind: 'list' })
  })

  // Typing "xyz" to find a chat must not delete the highlighted one (x asks, y confirms).
  it('a printable action key is filter text in a filtering picker, even on an empty filter', () => {
    let s = initialPickerState(rich)
    for (const k of text('xyz')) {
      const step = reducePicker(s, k)
      expect(step.outcome).toBeUndefined()
      s = step.state
    }
    expect(s.query).toBe('xyz')
    expect(s.mode).toBeUndefined()
    // Without a filter the key still acts.
    const plain = reducePicker(initialPickerState({ ...rich, filter: false }), { type: 'text', ch: 'x' }).state
    expect(plain.mode).toMatchObject({ kind: 'confirm', action: 'delete' })
  })

  it('a row action with nothing highlighted says so; a global one still runs', () => {
    let s = initialPickerState(rich)
    for (const k of text('zzz')) s = reducePicker(s, k).state
    expect(reducePicker(s, { type: 'ctrl', name: 'd' }).state.notice).toBe('nothing selected')
    expect(reducePicker(s, { type: 'ctrl', name: 'a' }).outcome).toEqual({ kind: 'action', id: 'scope', value: null })
  })

  // The /model picker: dozens of fetched models on a short screen, filtered by provider.
  it('a model list filtered on its provider keyword stays within the screen and commits the match', async () => {
    const models: PickerSpec = {
      title: 'Model:',
      filter: true,
      options: Array.from({ length: 40 }, (_, i) => {
        const provider = i % 3 === 0 ? 'OpenAI' : 'Anthropic'
        return { label: `model-${i}`, value: String(i), description: provider, keywords: provider }
      })
    }
    const keys: PickerKey[] = [...'openai'].map((ch) => ({ type: 'text', ch }) as PickerKey)
    keys.push({ type: 'down' }, { type: 'enter' })
    const { outcome, frames } = await drivePicker(models, keys, paint, { width: 60, height: 12 })
    for (const f of frames) {
      expect(f.length).toBeLessThanOrEqual(11) // one row spare for the cursor under it
      for (const l of f) expect(visibleWidth(l)).toBeLessThanOrEqual(59)
    }
    expect(outcome).toEqual({ kind: 'commit', value: '3' }) // the second OpenAI model
  })

  it('windows long lists around the cursor, with counts of the rest', () => {
    expect(pickerWindowStart(0, 20, 5)).toBe(0)
    expect(pickerWindowStart(10, 20, 5)).toBe(8)
    expect(pickerWindowStart(19, 20, 5)).toBe(15)
    expect(pickerWindowStart(3, 4, 5)).toBe(0)
    const many = Array.from({ length: 20 }, (_, i) => ({ label: `row ${i}`, value: String(i) }))
    const s = { ...initialPickerState({ ...rich, options: many, maxRows: 5 }), cursor: 10 }
    const out = renderPicker(s, paint).join('\n')
    expect(out).toContain('↑ 8 more')
    expect(out).toContain('↓ 7 more')
    expect(out).toContain('› row 10')
    expect(out).not.toContain('row 7\n')
  })

  it('cuts every line to the width, wraps the footer between keys, and fits the height', () => {
    const long = { ...rich, options: [{ label: 'x'.repeat(200), value: 'a' }], preview: () => ['p1', 'p2', 'p3'] }
    const lines = renderPicker(initialPickerState(long), paint, { width: 30 })
    for (const l of lines) expect([...l].length).toBeLessThanOrEqual(29)
    expect(lines).toContain('p1')
    expect(wrapHint('a · b · c', 0)).toEqual(['a · b · c'])
    expect(wrapHint('aaaa · bbbb · cccc', 12)).toEqual(['aaaa · bbbb', 'cccc'])
    // Too short for the preview: it goes, so the region stays on screen.
    const short = renderPicker(initialPickerState(long), paint, { width: 80, height: 8 })
    expect(short).not.toContain('p1')
    expect(short.length).toBeLessThan(8)
  })

  it('the session fetches rows through onQuery and keeps its place across an action', async () => {
    const queries: string[] = []
    let options = rows
    const session = createPickerSession(
      {
        ...rich,
        initialQuery: 'auth',
        onQuery: (q) => {
          queries.push(q)
          return filterPickerOptions(options, q)
        },
        onAction: (req) => {
          options = options.map((o) => (o.value === req.value ? { ...o, label: req.text ?? o.label } : o))
          return { options: filterPickerOptions(options, req.query), notice: `renamed ${req.value}` }
        }
      },
      paint
    )
    expect(queries).toEqual(['auth'])
    await session.press({ type: 'down' })
    await session.press({ type: 'ctrl', name: 'r' })
    for (const k of text(' v2')) await session.press(k)
    expect(await session.press({ type: 'enter' })).toBeUndefined()
    const out = session.lines().join('\n')
    expect(out).toContain('› Auth tests v2')
    expect(out).toContain('· renamed c')
    expect(await session.press({ type: 'enter' })).toEqual({ kind: 'commit', value: 'c' })
  })

  it('an action error becomes a notice; done closes; no onAction returns the action', async () => {
    const failing = createPickerSession(
      {
        ...rich,
        onAction: () => {
          throw new Error('disk full')
        }
      },
      paint
    )
    expect(await failing.press({ type: 'ctrl', name: 'a' })).toBeUndefined()
    expect(failing.lines().join('\n')).toContain("that didn't work: disk full")
    const closing = await drivePicker(
      { ...rich, onAction: () => ({ done: { kind: 'commit', value: 'z' } }) },
      [{ type: 'ctrl', name: 'a' }],
      paint
    )
    expect(closing.outcome).toEqual({ kind: 'commit', value: 'z' })
    const raw = await drivePicker(rich, [{ type: 'ctrl', name: 'a' }], paint)
    expect(raw.outcome).toEqual({ kind: 'action', id: 'scope', value: 'a' }) // the highlighted row, if any
    expect((await drivePicker(rich, [], paint)).outcome).toEqual({ kind: 'cancel' })
  })

  it('a plain picker renders exactly as before (no filter line, same footer)', () => {
    expect(renderPicker(initialPickerState(spec), paint, { width: 20 })).toEqual(renderPicker(initialPickerState(spec), paint))
    expect(renderPicker(initialPickerState(spec), paint).at(-1)).toBe(
      '↑/↓ move · enter confirm · type for a custom answer · esc cancel'
    )
  })
})

describe('numbered picker (screen-reader mode)', () => {
  const approval: PickerSpec = {
    title: 'Choose:',
    escLabel: 'deny',
    options: [
      { label: 'Allow', value: 'allow' },
      { label: 'Deny', value: 'deny', description: 'tell it no' },
      { label: 'Allow for run', value: 'session' }
    ]
  }

  it('lists the options by number and says how to answer, with no pointer or keys', () => {
    expect(renderNumberedPicker(approval)).toEqual([
      'Choose:',
      '1. Allow',
      '2. Deny (tell it no)',
      '3. Allow for run',
      'Type a number and press Enter. Or type your own answer. Enter on its own: deny.'
    ])
    expect(renderNumberedPicker({ ...approval, multiSelect: true, title: '' }).at(-1)).toContain(
      'separated by spaces or commas'
    )
  })

  it('commits the numbered option, and Enter alone takes the Esc path', () => {
    expect(parseNumberedPick(approval, ' 3 ')).toEqual({ kind: 'commit', value: 'session' })
    expect(parseNumberedPick(approval, '')).toEqual({ kind: 'cancel' })
  })

  it('hands any other answer back as typed text, so nothing is asked twice', () => {
    expect(parseNumberedPick(approval, 'n not that file')).toEqual({ kind: 'type', text: 'n not that file' })
    expect(parseNumberedPick(approval, 'y')).toEqual({ kind: 'type', text: 'y' })
    expect(parseNumberedPick({ title: '', options: [] }, '1')).toEqual({ kind: 'type', text: '1' })
  })

  it('asks again for a number that is not on the list, or two numbers for one choice', () => {
    expect(parseNumberedPick(approval, '7')).toEqual({ kind: 'invalid', message: 'There is no option 7. Choose 1 to 3.' })
    expect(parseNumberedPick(approval, '0')).toMatchObject({ kind: 'invalid' })
    expect(parseNumberedPick(approval, '1 2')).toEqual({ kind: 'invalid', message: 'Choose one option. Choose 1 to 3.' })
  })

  it('takes several numbers for a multi-select, in list order, once each', () => {
    const multi = { ...approval, multiSelect: true }
    expect(parseNumberedPick(multi, '3, 1 3')).toEqual({ kind: 'commit', value: 'allow, session' })
  })

  // The numbered list answers the way the picker does: an option's key picks it, and
  // where there is no typed answer (a plan, the network questions) other text asks again.
  describe('with option keys', () => {
    const keyed: PickerSpec = {
      title: 'Choose:',
      escLabel: 'deny',
      typeLabel: 'type a reason to deny',
      options: [
        { label: 'Allow once', value: 'allow', key: 'y' },
        { label: 'Deny with a reason…', value: 'deny-note' },
        { label: 'Deny', value: 'deny', key: 'n' }
      ]
    }
    it('lists each key after its number and says what typing does', () => {
      expect(renderNumberedPicker(keyed)).toEqual([
        'Choose:',
        '1, or y. Allow once',
        '2. Deny with a reason…',
        '3, or n. Deny',
        'Type a number or the key after it and press Enter. Or type a reason to deny. Enter on its own: deny.'
      ])
      expect(renderNumberedPicker({ ...keyed, typeLabel: null }).at(-1)).toBe(
        'Type a number or the key after it and press Enter. Enter on its own: deny.'
      )
    })
    it('commits a key, and keeps other text as the typed answer', () => {
      expect(parseNumberedPick(keyed, 'Y')).toEqual({ kind: 'commit', value: 'allow' })
      expect(parseNumberedPick(keyed, ' n ')).toEqual({ kind: 'commit', value: 'deny' })
      expect(parseNumberedPick(keyed, 'use pnpm')).toEqual({ kind: 'type', text: 'use pnpm' })
    })
    it('asks again for text where there is no typed answer', () => {
      expect(parseNumberedPick({ ...keyed, typeLabel: null }, 'maybe')).toEqual({
        kind: 'invalid',
        message: 'Choose 1 to 3, or type y, n.'
      })
    })
  })
})

// /tasks: Enter views the highlighted task and `x` stops it, so `x` is an action
// without a filter, and nothing falls back to a typed answer.
describe('action keys without a filter', () => {
  const tasks: PickerSpec = {
    title: 'Background tasks:',
    enterLabel: 'view',
    actions: [{ id: 'kill', keys: ['x'], label: 'kill' }],
    options: [
      { label: '1. shell  npm run dev', value: '0' },
      { label: '2. agent  scan', value: '1' }
    ]
  }

  it('maps keys through the rich mapping, and leaves plain pickers as before', () => {
    expect(pickerKeyFor(tasks, { sequence: 'x', name: 'x' })).toEqual({ type: 'text', ch: 'x' })
    expect(pickerKeyFor(tasks, { name: 'c', sequence: '\x03', ctrl: true })).toEqual({ type: 'interrupt' })
    // Without actions, `x` is still a request to type.
    expect(pickerKeyFor(spec, { sequence: 'x', name: 'x' })).toEqual({ type: 'char', ch: 'x' })
  })

  it('ends with the action and the highlighted option', () => {
    const moved = reducePicker(initialPickerState(tasks), { type: 'down' }).state
    expect(reducePicker(moved, { type: 'text', ch: 'x' }).outcome).toEqual({ kind: 'action', id: 'kill', value: '1' })
    expect(reducePicker(moved, { type: 'enter' }).outcome).toEqual({ kind: 'commit', value: '1' })
  })

  it('ignores other printable keys', () => {
    const s = initialPickerState(tasks)
    const step = reducePicker(s, { type: 'text', ch: 'q' })
    expect(step.outcome).toBeUndefined()
    expect(step.state.query).toBeUndefined()
  })

  it('names the labelled keys in the footer instead of offering a typed answer', () => {
    const lines = renderPicker(initialPickerState(tasks), makePainter(false))
    expect(lines[lines.length - 1]).toBe('↑/↓ move · enter view · x kill · esc cancel')
  })

  it('does nothing on an empty list', () => {
    const empty = initialPickerState({ ...tasks, options: [] })
    const step = reducePicker(empty, { type: 'text', ch: 'x' })
    expect(step.outcome).toBeUndefined()
    expect(step.state.notice).toBe('nothing selected')
  })
})

describe('initialCursor', () => {
  const options = [
    { label: 'a', value: 'a' },
    { label: 'b', value: 'b' },
    { label: 'c', value: 'c' }
  ]
  it('starts on the given row, clamped to the rows', () => {
    expect(initialPickerState({ title: '', options, initialCursor: 2 }).cursor).toBe(2)
    expect(initialPickerState({ title: '', options, initialCursor: 9 }).cursor).toBe(2)
    expect(initialPickerState({ title: '', options, initialCursor: -3 }).cursor).toBe(0)
    expect(initialPickerState({ title: '', options, initialCursor: Number.NaN }).cursor).toBe(0)
    expect(initialPickerState({ title: '', options: [], initialCursor: 1 }).cursor).toBe(0)
    expect(initialPickerState({ title: '', options }).cursor).toBe(0)
  })
})
