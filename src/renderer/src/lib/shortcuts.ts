/**
 * App keyboard shortcuts as a declarative registry. A single list of binding
 * descriptors is the source of truth for:
 *   - matching a key event to an action id ({@link matchShortcut}), and
 *   - rendering the keyboard-shortcuts help overlay (grouped by category).
 *
 * App wires each action id to a handler. Keeping the match logic pure (a key event
 * in, an id out) keeps it testable and lets the help overlay derive its display
 * straight from the same data, so the two can never drift.
 *
 * `mod` is the platform command key — ⌘ on macOS, Ctrl on Windows/Linux — matched
 * as `metaKey || ctrlKey` so a single chord works on both.
 */

export type ShortcutId =
  | 'new-chat'
  | 'command-palette'
  | 'toggle-sidebar'
  | 'open-settings'
  | 'show-help'
  | 'escape'
  | 'send-message'
  | 'insert-newline'

export type ShortcutCategory = 'General' | 'Navigation' | 'Chat' | 'Modes'

/** Categories in the order the help overlay lists them. */
export const SHORTCUT_CATEGORIES: ShortcutCategory[] = ['General', 'Navigation', 'Chat', 'Modes']

/**
 * Where a shortcut is handled. `global` shortcuts are dispatched by the app-level
 * key listener ({@link matchShortcut} only considers these). `composer` shortcuts
 * are handled inside their own component — they appear in the help overlay for
 * reference but are not matched globally.
 */
export type ShortcutScope = 'global' | 'composer'

/** A single key chord. The base `key` is matched case-insensitively against `KeyboardEvent.key`. */
export interface KeyChord {
  key: string
  /** Requires the platform command key (⌘ on macOS, Ctrl elsewhere). */
  mod?: boolean
  /** Requires Shift. When unset, Shift is ignored so e.g. ⇧⌘N still triggers a ⌘N chord. */
  shift?: boolean
  /** Requires Alt/Option. */
  alt?: boolean
}

export interface ShortcutDef {
  id: ShortcutId
  /** Chords that trigger the action — any one matches. Each is shown in the overlay. */
  chords: KeyChord[]
  /** Human-readable description for the help overlay. */
  label: string
  category: ShortcutCategory
  /** Defaults to `global`. */
  scope?: ShortcutScope
}

/** The shortcut registry. New shortcuts are added here and picked up everywhere. */
export const SHORTCUTS: ShortcutDef[] = [
  {
    id: 'new-chat',
    chords: [{ key: 'n', mod: true }],
    label: 'New chat',
    category: 'General'
  },
  {
    id: 'command-palette',
    chords: [{ key: 'k', mod: true }],
    label: 'Command palette',
    category: 'General'
  },
  {
    id: 'toggle-sidebar',
    chords: [{ key: 'b', mod: true }],
    label: 'Toggle sidebar',
    category: 'General'
  },
  {
    id: 'open-settings',
    chords: [{ key: ',', mod: true }],
    label: 'Open settings',
    category: 'General'
  },
  {
    id: 'show-help',
    chords: [{ key: '/', mod: true }, { key: '?' }],
    label: 'Keyboard shortcuts',
    category: 'General'
  },
  {
    id: 'escape',
    chords: [{ key: 'Escape' }],
    label: 'Stop the current turn, or close an open dialog',
    category: 'General'
  },
  {
    id: 'send-message',
    chords: [{ key: 'Enter' }],
    label: 'Send message',
    category: 'Chat',
    scope: 'composer'
  },
  {
    id: 'insert-newline',
    chords: [{ key: 'Enter', shift: true }],
    label: 'Insert a line break',
    category: 'Chat',
    scope: 'composer'
  }
]

export interface Keyish {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey?: boolean
  altKey?: boolean
}

function chordMatches(e: Keyish, c: KeyChord): boolean {
  const mod = e.metaKey || e.ctrlKey
  if ((c.mod ?? false) !== mod) return false
  if ((c.alt ?? false) !== Boolean(e.altKey)) return false
  // Shift is enforced only when the chord requires it: this keeps ⇧⌘N matching the
  // ⌘N chord (prior behaviour, and what a user expects), while letting a
  // shift-specific chord like ⇧Tab stay distinct from plain Tab.
  if (c.shift && !e.shiftKey) return false
  return e.key.toLowerCase() === c.key.toLowerCase()
}

/**
 * Resolve a key event to a global shortcut id, or null. Only `global`-scope
 * shortcuts are considered; composer shortcuts are handled in their own component.
 */
export function matchShortcut(e: Keyish): ShortcutId | null {
  for (const def of SHORTCUTS) {
    if ((def.scope ?? 'global') !== 'global') continue
    for (const c of def.chords) {
      if (chordMatches(e, c)) return def.id
    }
  }
  return null
}

/** True for elements that capture typing, where plain-character shortcuts shouldn't fire. */
export function isEditableTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true
}

/** Best-effort macOS detection, for rendering ⌘/⇧/⌥ glyphs instead of Ctrl/Shift/Alt. */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  const p = navigator.platform || navigator.userAgent || ''
  return /Mac|iPhone|iPad|iPod/.test(p)
}

const KEY_GLYPH: Record<string, string> = {
  Escape: 'Esc',
  Enter: '↵',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  ' ': 'Space',
  Tab: 'Tab'
}

/** The display string for a shortcut's primary chord, e.g. `⌘K`, or undefined if unknown. */
export function shortcutHint(id: ShortcutId, mac: boolean): string | undefined {
  const def = SHORTCUTS.find((s) => s.id === id)
  return def ? formatChord(def.chords[0], mac) : undefined
}

/** Render a chord as a display string, e.g. `⌘N` on macOS or `Ctrl+N` elsewhere. */
export function formatChord(c: KeyChord, mac: boolean): string {
  const parts: string[] = []
  if (c.mod) parts.push(mac ? '⌘' : 'Ctrl')
  if (c.alt) parts.push(mac ? '⌥' : 'Alt')
  if (c.shift) parts.push(mac ? '⇧' : 'Shift')
  const k = KEY_GLYPH[c.key] ?? (c.key.length === 1 ? c.key.toUpperCase() : c.key)
  parts.push(k)
  return mac ? parts.join('') : parts.join('+')
}
