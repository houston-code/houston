import type { EditorStatus } from '@shared/editors'

/**
 * Detected editors for the per-chat "Open in…" menu. Guarded so a partially-stubbed
 * `window.api` (tests) or a missing preload resolves to an empty list rather than
 * throwing. Fetched fresh each time a menu opens — cheap, and avoids a module-level
 * cache that would leak the install set across test cases.
 */
export function listEditors(): Promise<EditorStatus[]> {
  return Promise.resolve(window.api?.listEditors?.() ?? [])
}

/** Platform-appropriate file-manager name for the "Reveal in…" item. */
export function fileManagerName(): string {
  const p = navigator.platform.toLowerCase()
  if (p.includes('mac')) return 'Finder'
  if (p.includes('win')) return 'File Explorer'
  return 'File Manager'
}
