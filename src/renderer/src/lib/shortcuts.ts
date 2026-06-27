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
  | 'switch-model'
  | 'find-in-chat'
  | 'toggle-sidebar'
  | 'toggle-terminal'
  | 'open-settings'
  | 'show-help'
  | 'escape'
  | 'select-chat-n'
  | 'next-chat'
  | 'prev-chat'
  | 'cycle-mode'
  | 'send-message'
  | 'insert-newline'
  | 'edit-last-message'
  | 'history-recall'

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
  /**
   * Requires the raw Control key specifically (⌃), independent of platform — and
   * disallows ⌘. Use for bindings like ⌃Tab where ⌘Tab is reserved by the OS.
   */
  ctrl?: boolean
  /**
   * Shift requirement. `true` requires it, `false` forbids it, unset ignores it (so
   * e.g. ⇧⌘N still triggers a ⌘N chord while ⌃⇧Tab stays distinct from ⌃Tab).
   */
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
  /**
   * Custom display string for the help overlay / hints, when listing every chord
   * would be noise (e.g. a range like ⌘1–9). Overrides per-chord formatting.
   */
  display?: (mac: boolean) => string
  /** Reserved binding that can't be user-rebound (e.g. Escape's cancel semantics). */
  fixed?: boolean
}

/**
 * Whether a shortcut can be user-rebound: a single-chord, global, non-fixed binding
 * without a custom display. (Multi-chord / range / composer-handled shortcuts and
 * Escape are left as-is.)
 */
export function isCustomizable(def: ShortcutDef): boolean {
  return (
    (def.scope ?? 'global') === 'global' &&
    !def.fixed &&
    !def.display &&
    def.chords.length === 1
  )
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
    id: 'switch-model',
    chords: [{ key: 'm', mod: true, shift: true }],
    label: 'Switch model',
    category: 'General'
  },
  {
    id: 'find-in-chat',
    chords: [{ key: 'f', mod: true }],
    label: 'Find in conversation',
    category: 'Navigation'
  },
  {
    id: 'toggle-sidebar',
    chords: [{ key: 'b', mod: true }],
    label: 'Toggle sidebar',
    category: 'General'
  },
  {
    id: 'toggle-terminal',
    chords: [{ key: '`', ctrl: true }],
    label: 'Toggle the integrated terminal',
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
    category: 'General',
    fixed: true
  },
  {
    id: 'select-chat-n',
    chords: Array.from({ length: 9 }, (_, i) => ({ key: String(i + 1), mod: true })),
    label: 'Switch to chat 1–9',
    category: 'Navigation',
    display: (mac) => (mac ? '⌘1–9' : 'Ctrl+1–9')
  },
  {
    id: 'next-chat',
    chords: [{ key: 'Tab', ctrl: true, shift: false }],
    label: 'Next chat',
    category: 'Navigation'
  },
  {
    id: 'prev-chat',
    chords: [{ key: 'Tab', ctrl: true, shift: true }],
    label: 'Previous chat',
    category: 'Navigation'
  },
  {
    id: 'cycle-mode',
    chords: [{ key: 'Tab', shift: true }],
    label: 'Cycle approval mode (plan → ask → auto → full)',
    category: 'Modes'
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
  },
  {
    id: 'edit-last-message',
    chords: [{ key: 'Escape' }],
    label: 'Edit last message (when the field is empty)',
    category: 'Chat',
    scope: 'composer',
    display: () => 'Esc Esc'
  },
  {
    id: 'history-recall',
    chords: [{ key: 'ArrowUp' }],
    label: 'Recall a previous prompt (when the field is empty)',
    category: 'Chat',
    scope: 'composer',
    display: () => '↑ / ↓'
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
  if (c.ctrl !== undefined) {
    // Raw-Control binding: match Control exactly and never with ⌘ held.
    if (e.ctrlKey !== c.ctrl || e.metaKey) return false
  } else {
    const mod = e.metaKey || e.ctrlKey
    if ((c.mod ?? false) !== mod) return false
  }
  if ((c.alt ?? false) !== Boolean(e.altKey)) return false
  // Shift: enforced when true, forbidden when false, ignored when unset. The ignore
  // case keeps ⇧⌘N matching the ⌘N chord; the explicit cases let ⌃Tab / ⌃⇧Tab split.
  if (c.shift === true && !e.shiftKey) return false
  if (c.shift === false && e.shiftKey) return false
  return e.key.toLowerCase() === c.key.toLowerCase()
}

/**
 * Resolve a key event to a global shortcut id, or null. Only `global`-scope
 * shortcuts are considered; composer shortcuts are handled in their own component.
 * Pass a resolved registry (defaults + user overrides) to honour customizations.
 */
export function matchShortcut(e: Keyish, defs: ShortcutDef[] = SHORTCUTS): ShortcutId | null {
  for (const def of defs) {
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

/** The display string(s) for a shortcut: a custom override, else each chord formatted. */
export function shortcutDisplays(def: ShortcutDef, mac: boolean): string[] {
  if (def.display) return [def.display(mac)]
  return def.chords.map((c) => formatChord(c, mac))
}

/** The display string for a shortcut's primary chord, e.g. `⌘K`, or undefined if unbound. */
export function shortcutHint(
  id: ShortcutId,
  mac: boolean,
  defs: ShortcutDef[] = SHORTCUTS
): string | undefined {
  const def = defs.find((s) => s.id === id)
  return def ? shortcutDisplays(def, mac)[0] : undefined
}

/** Render a chord as a display string, e.g. `⌘N` on macOS or `Ctrl+N` elsewhere. */
export function formatChord(c: KeyChord, mac: boolean): string {
  const parts: string[] = []
  if (c.mod) parts.push(mac ? '⌘' : 'Ctrl')
  if (c.ctrl) parts.push(mac ? '⌃' : 'Ctrl')
  if (c.alt) parts.push(mac ? '⌥' : 'Alt')
  if (c.shift) parts.push(mac ? '⇧' : 'Shift')
  const k = KEY_GLYPH[c.key] ?? (c.key.length === 1 ? c.key.toUpperCase() : c.key)
  parts.push(k)
  return mac ? parts.join('') : parts.join('+')
}
