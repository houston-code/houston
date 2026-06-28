/**
 * The composer's unsent draft, persisted to localStorage so text typed but not
 * yet sent survives an app restart. Renderer-only, like the prompt history
 * (see promptHistory.ts) — no main-process round-trip, and Chromium-backed
 * localStorage persists across restarts on macOS, Linux and Windows alike.
 *
 * A single draft is kept: the composer already carries one draft across the
 * session regardless of which chat is open, so that's what we save and restore.
 * Only the text is persisted — pending image attachments are not (they can be
 * large and would risk the localStorage quota).
 */

const KEY = 'houston.composerDraft'

/** Load the saved draft, tolerating absent/unavailable storage (→ ''). */
export function loadComposerDraft(): string {
  try {
    return localStorage.getItem(KEY) ?? ''
  } catch {
    return ''
  }
}

/** Persist the current draft, or clear it when empty so storage stays tidy. */
export function saveComposerDraft(text: string): void {
  try {
    if (text) localStorage.setItem(KEY, text)
    else localStorage.removeItem(KEY)
  } catch {
    // Storage full/unavailable — the draft just won't survive restart; not worth surfacing.
  }
}
