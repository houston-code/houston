/**
 * User keybinding overrides: the serialization between a {@link KeyChord} and the
 * `string` stored in settings, the chord captured from a live key event (the
 * "record a shortcut" UI), and resolving the default registry against a user's
 * overrides so the rest of the app matches/display against the effective bindings.
 */
import { SHORTCUTS, type KeyChord, type ShortcutDef, type ShortcutId } from './shortcuts'

/** Overrides keyed by shortcut id: a chord string rebinds, `null` disables, absent = default. */
export type KeybindingOverrides = Record<string, string | null>

/** Serialize a chord to a stored string, e.g. `mod+k`, `ctrl+shift+Tab`, `mod+/`. */
export function chordToString(c: KeyChord): string {
  const parts: string[] = []
  if (c.mod) parts.push('mod')
  if (c.ctrl) parts.push('ctrl')
  if (c.alt) parts.push('alt')
  if (c.shift) parts.push('shift')
  parts.push(c.key)
  return parts.join('+')
}

/** Parse a stored chord string back to a chord, or null if it has no key. */
export function chordFromString(s: string): KeyChord | null {
  let rest = s.trim()
  if (!rest) return null
  const chord: KeyChord = { key: '' }
  for (;;) {
    const m = /^(mod|ctrl|alt|shift)\+/i.exec(rest)
    if (!m) break
    const tok = m[1].toLowerCase()
    if (tok === 'mod') chord.mod = true
    else if (tok === 'ctrl') chord.ctrl = true
    else if (tok === 'alt') chord.alt = true
    else chord.shift = true
    rest = rest.slice(m[0].length)
  }
  if (!rest) return null // modifiers only, no base key
  chord.key = rest // verbatim, e.g. 'k', 'Tab', '/'
  return chord
}

/** Build a chord from a live key event, or null for a bare modifier press. */
export function chordFromEvent(e: {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}): KeyChord | null {
  if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return null
  const chord: KeyChord = { key: e.key }
  // Normalize the platform command key to `mod` so a binding works on both OSes.
  if (e.metaKey || e.ctrlKey) chord.mod = true
  if (e.shiftKey) chord.shift = true
  if (e.altKey) chord.alt = true
  return chord
}

/**
 * The effective registry: defaults with each user override applied. A string
 * override replaces the chord (and clears any range/display); `null` unbinds it.
 */
export function resolveShortcuts(overrides?: KeybindingOverrides): ShortcutDef[] {
  if (!overrides) return SHORTCUTS
  return SHORTCUTS.map((def) => {
    if (!(def.id in overrides)) return def
    const ov = overrides[def.id]
    if (ov === null) return { ...def, chords: [], display: undefined }
    const chord = chordFromString(ov)
    return chord ? { ...def, chords: [chord], display: undefined } : def
  })
}

/** The current binding string for a shortcut: the override, or its default chord. */
export function effectiveBinding(id: ShortcutId, overrides?: KeybindingOverrides): string | null {
  if (overrides && id in overrides) return overrides[id]
  const def = SHORTCUTS.find((s) => s.id === id)
  return def && def.chords[0] ? chordToString(def.chords[0]) : null
}
