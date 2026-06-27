import { describe, it, expect } from 'vitest'
import {
  matchShortcut,
  formatChord,
  isEditableTarget,
  SHORTCUTS,
  type Keyish
} from './shortcuts'

const ev = (key: string, mod = false, extra: Partial<Keyish> = {}): Keyish => ({
  key,
  metaKey: mod,
  ctrlKey: false,
  ...extra
})

describe('matchShortcut', () => {
  it('maps Cmd/Ctrl+N to new-chat (either modifier, either case)', () => {
    expect(matchShortcut(ev('n', true))).toBe('new-chat')
    expect(matchShortcut({ key: 'N', metaKey: false, ctrlKey: true })).toBe('new-chat')
  })

  it('maps Cmd/Ctrl+B to toggle-sidebar', () => {
    expect(matchShortcut(ev('b', true))).toBe('toggle-sidebar')
    expect(matchShortcut({ key: 'B', metaKey: false, ctrlKey: true })).toBe('toggle-sidebar')
  })

  it('maps Cmd/Ctrl+comma to open-settings', () => {
    expect(matchShortcut(ev(',', true))).toBe('open-settings')
  })

  it('maps both Cmd/Ctrl+slash and a bare ? to show-help', () => {
    expect(matchShortcut(ev('/', true))).toBe('show-help')
    expect(matchShortcut(ev('?', false, { shiftKey: true }))).toBe('show-help')
  })

  it('maps Escape to escape (no modifier needed)', () => {
    expect(matchShortcut(ev('Escape'))).toBe('escape')
  })

  it('ignores Shift on a non-shift chord (⇧⌘N still triggers new-chat)', () => {
    expect(matchShortcut(ev('N', true, { shiftKey: true }))).toBe('new-chat')
  })

  it('ignores plain keys and unmodified letters', () => {
    expect(matchShortcut(ev('n'))).toBeNull()
    expect(matchShortcut(ev('a', true))).toBeNull()
  })

  it('does not match composer-scope shortcuts globally (Enter is not a global action)', () => {
    expect(matchShortcut(ev('Enter'))).toBeNull()
  })
})

describe('formatChord', () => {
  it('uses glyphs on macOS and words elsewhere', () => {
    expect(formatChord({ key: 'n', mod: true }, true)).toBe('⌘N')
    expect(formatChord({ key: 'n', mod: true }, false)).toBe('Ctrl+N')
  })

  it('renders named keys and modifiers', () => {
    expect(formatChord({ key: 'Escape' }, true)).toBe('Esc')
    expect(formatChord({ key: 'Enter', shift: true }, true)).toBe('⇧↵')
    expect(formatChord({ key: 'Enter', shift: true }, false)).toBe('Shift+↵')
  })

  it('renders punctuation as-is', () => {
    expect(formatChord({ key: '/', mod: true }, true)).toBe('⌘/')
    expect(formatChord({ key: '?' }, true)).toBe('?')
  })
})

describe('isEditableTarget', () => {
  it('is true for inputs, textareas, selects and contenteditable', () => {
    expect(isEditableTarget(document.createElement('input'))).toBe(true)
    expect(isEditableTarget(document.createElement('textarea'))).toBe(true)
    expect(isEditableTarget(document.createElement('select'))).toBe(true)
    // (jsdom doesn't reflect contentEditable into isContentEditable, so a true
    // contenteditable can't be asserted here — cover the non-editable cases.)
    expect(isEditableTarget(document.createElement('div'))).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
  })
})

describe('SHORTCUTS registry', () => {
  it('has a unique id per entry', () => {
    const ids = SHORTCUTS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('gives every entry at least one chord and a label', () => {
    for (const s of SHORTCUTS) {
      expect(s.chords.length).toBeGreaterThan(0)
      expect(s.label.length).toBeGreaterThan(0)
    }
  })
})
