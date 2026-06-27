/**
 * App keyboard shortcuts. Kept as a pure mapping from a key event to an action so
 * it's testable; App wires each action to a handler.
 *
 * - Cmd/Ctrl+N      → new chat
 * - Cmd/Ctrl+,      → open settings
 * - Cmd/Ctrl+B      → toggle the sidebar (collapse / expand)
 * - Escape          → stop a running turn / close an open dialog
 */
export type ShortcutAction = 'new-chat' | 'open-settings' | 'toggle-sidebar' | 'escape'

export interface Keyish {
  key: string
  metaKey: boolean
  ctrlKey: boolean
}

export function shortcutFor(e: Keyish): ShortcutAction | null {
  const mod = e.metaKey || e.ctrlKey
  if (mod && (e.key === 'n' || e.key === 'N')) return 'new-chat'
  if (mod && (e.key === 'b' || e.key === 'B')) return 'toggle-sidebar'
  if (mod && e.key === ',') return 'open-settings'
  if (e.key === 'Escape') return 'escape'
  return null
}
