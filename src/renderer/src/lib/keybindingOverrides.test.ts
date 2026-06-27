import { describe, it, expect } from 'vitest'
import {
  chordToString,
  chordFromString,
  chordFromEvent,
  resolveShortcuts,
  effectiveBinding
} from './keybindingOverrides'
import { matchShortcut } from './shortcuts'

describe('chord serialization', () => {
  it('round-trips chords through string form', () => {
    for (const c of [
      { key: 'k', mod: true },
      { key: 'Tab', ctrl: true, shift: true },
      { key: '/', mod: true },
      { key: 'f', mod: true }
    ] as const) {
      expect(chordFromString(chordToString(c))).toEqual(c)
    }
  })

  it('serializes modifiers in a stable order', () => {
    expect(chordToString({ key: 'm', mod: true, shift: true })).toBe('mod+shift+m')
    expect(chordToString({ key: 'Escape' })).toBe('Escape')
  })

  it('parses case-insensitive modifiers, keeps the key verbatim, rejects modifier-only', () => {
    expect(chordFromString('MOD+K')).toEqual({ key: 'K', mod: true })
    expect(chordFromString('ctrl+shift+Tab')).toEqual({ key: 'Tab', ctrl: true, shift: true })
    expect(chordFromString('mod+')).toBeNull()
    expect(chordFromString('  ')).toBeNull()
  })
})

describe('chordFromEvent', () => {
  it('builds a chord, normalizing Ctrl/Cmd to mod', () => {
    expect(
      chordFromEvent({ key: 'k', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false })
    ).toEqual({ key: 'k', mod: true })
    expect(
      chordFromEvent({ key: 'k', metaKey: false, ctrlKey: true, shiftKey: false, altKey: false })
    ).toEqual({ key: 'k', mod: true })
  })

  it('returns null for a bare modifier press', () => {
    expect(
      chordFromEvent({ key: 'Shift', metaKey: false, ctrlKey: false, shiftKey: true, altKey: false })
    ).toBeNull()
  })
})

describe('resolveShortcuts', () => {
  it('matches the defaults unchanged with no overrides', () => {
    expect(matchShortcut({ key: 'n', metaKey: true, ctrlKey: false }, resolveShortcuts())).toBe(
      'new-chat'
    )
  })

  it('rebinds a shortcut to the override chord', () => {
    const defs = resolveShortcuts({ 'new-chat': 'mod+j' })
    // The new chord works…
    expect(matchShortcut({ key: 'j', metaKey: true, ctrlKey: false }, defs)).toBe('new-chat')
    // …and the old one no longer triggers new-chat.
    expect(matchShortcut({ key: 'n', metaKey: true, ctrlKey: false }, defs)).toBeNull()
  })

  it('unbinds a shortcut when set to null', () => {
    const defs = resolveShortcuts({ 'toggle-sidebar': null })
    expect(matchShortcut({ key: 'b', metaKey: true, ctrlKey: false }, defs)).toBeNull()
  })
})

describe('effectiveBinding', () => {
  it('reports the override when set, else the default chord', () => {
    expect(effectiveBinding('new-chat')).toBe('mod+n')
    expect(effectiveBinding('new-chat', { 'new-chat': 'mod+j' })).toBe('mod+j')
    expect(effectiveBinding('toggle-sidebar', { 'toggle-sidebar': null })).toBeNull()
  })
})
