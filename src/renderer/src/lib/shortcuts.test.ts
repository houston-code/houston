import { describe, it, expect } from 'vitest'
import {
  matchShortcut,
  formatChord,
  shortcutDisplays,
  isEditableTarget,
  isCustomizable,
  terminalKeepsKey,
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

  it('maps Cmd/Ctrl+F to find-in-chat and Cmd/Ctrl+Shift+M to switch-model', () => {
    expect(matchShortcut(ev('f', true))).toBe('find-in-chat')
    expect(matchShortcut(ev('m', true, { shiftKey: true }))).toBe('switch-model')
    // Plain Cmd+M (no shift) is not the model switcher.
    expect(matchShortcut(ev('m', true))).toBeNull()
  })

  it('maps Ctrl+backtick to toggle-terminal (raw Control, not ⌘)', () => {
    expect(matchShortcut({ key: '`', metaKey: false, ctrlKey: true })).toBe('toggle-terminal')
    // ⌘` is not the terminal toggle — the binding is Control-specific.
    expect(matchShortcut({ key: '`', metaKey: true, ctrlKey: false })).toBeNull()
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

  it('maps Cmd/Ctrl+digit to select-chat-n for 1–9', () => {
    expect(matchShortcut(ev('1', true))).toBe('select-chat-n')
    expect(matchShortcut(ev('9', true))).toBe('select-chat-n')
    expect(matchShortcut(ev('0', true))).toBeNull()
  })

  it('splits Ctrl+Tab (next) from Ctrl+Shift+Tab (prev) and ignores Cmd+Tab', () => {
    expect(matchShortcut({ key: 'Tab', metaKey: false, ctrlKey: true })).toBe('next-chat')
    expect(matchShortcut({ key: 'Tab', metaKey: false, ctrlKey: true, shiftKey: true })).toBe(
      'prev-chat'
    )
    // ⌘Tab is the OS app switcher — never ours.
    expect(matchShortcut({ key: 'Tab', metaKey: true, ctrlKey: true })).toBeNull()
    expect(matchShortcut({ key: 'Tab', metaKey: false, ctrlKey: false })).toBeNull()
  })

  it('maps plain Shift+Tab to cycle-mode, distinct from the Ctrl+Tab nav chords', () => {
    expect(matchShortcut({ key: 'Tab', metaKey: false, ctrlKey: false, shiftKey: true })).toBe(
      'cycle-mode'
    )
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

  it('renders raw Control as ⌃ on macOS', () => {
    expect(formatChord({ key: 'Tab', ctrl: true }, true)).toBe('⌃Tab')
    expect(formatChord({ key: 'Tab', ctrl: true, shift: true }, false)).toBe('Ctrl+Shift+Tab')
  })
})

describe('shortcutDisplays', () => {
  it('uses a custom display override when present (⌘1–9), else formats chords', () => {
    const nth = SHORTCUTS.find((s) => s.id === 'select-chat-n')!
    expect(shortcutDisplays(nth, true)).toEqual(['⌘1–9'])
    expect(shortcutDisplays(nth, false)).toEqual(['Ctrl+1–9'])
    const help = SHORTCUTS.find((s) => s.id === 'show-help')!
    expect(shortcutDisplays(help, true)).toEqual(['⌘/', '?'])
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

describe('terminalKeepsKey', () => {
  it('lets the shell keep Ctrl-chords and plain keys', () => {
    expect(terminalKeepsKey('next-chat', false)).toBe(true) // ⌃Tab → shell
    expect(terminalKeepsKey('cycle-mode', false)).toBe(true) // Shift+Tab → shell
    expect(terminalKeepsKey(null, false)).toBe(true) // Ctrl+C etc. → shell
  })

  it('lets ⌘-chords through to the app (the shell never receives ⌘)', () => {
    expect(terminalKeepsKey('command-palette', true)).toBe(false) // ⌘K → app
    expect(terminalKeepsKey('find-in-chat', true)).toBe(false) // ⌘F → app
  })

  it('always lets the terminal toggle reach the app', () => {
    expect(terminalKeepsKey('toggle-terminal', false)).toBe(false)
  })
})

describe('isCustomizable', () => {
  const byId = (id: string) => SHORTCUTS.find((s) => s.id === id)!

  it('is true for single-chord global shortcuts', () => {
    expect(isCustomizable(byId('new-chat'))).toBe(true)
    expect(isCustomizable(byId('command-palette'))).toBe(true)
    expect(isCustomizable(byId('next-chat'))).toBe(true)
  })

  it('is false for fixed, composer-scope, multi-chord and range shortcuts', () => {
    expect(isCustomizable(byId('escape'))).toBe(false) // fixed
    expect(isCustomizable(byId('send-message'))).toBe(false) // composer scope
    expect(isCustomizable(byId('show-help'))).toBe(false) // two chords
    expect(isCustomizable(byId('select-chat-n'))).toBe(false) // custom display (range)
  })
})
