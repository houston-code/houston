/**
 * The composer's unsent draft, persisted to localStorage so text typed but not
 * yet sent survives an app restart. Renderer-only, like the prompt history
 * (see promptHistory.ts) — no main-process round-trip, and Chromium-backed
 * localStorage persists across restarts on macOS, Linux and Windows alike.
 *
 * Drafts are keyed per conversation, so each chat keeps its own lingering text
 * in isolation — a draft left in one chat never shows up in another, and every
 * chat's draft survives a restart. The not-yet-created "new chat" composer gets
 * its own slot. Only the text is persisted — pending image attachments are not
 * (they can be large and would risk the localStorage quota).
 */

const PREFIX = 'houston.composerDraft'

/** Storage key for a conversation's draft; the new-chat composer gets its own slot. */
function keyFor(conversationId: string | null): string {
  return `${PREFIX}:${conversationId ?? 'new'}`
}

/** Load a conversation's saved draft, tolerating absent/unavailable storage (→ ''). */
export function loadComposerDraft(conversationId: string | null): string {
  try {
    return localStorage.getItem(keyFor(conversationId)) ?? ''
  } catch {
    return ''
  }
}

/** Persist a conversation's draft, or clear it when empty so storage stays tidy. */
export function saveComposerDraft(conversationId: string | null, text: string): void {
  try {
    const key = keyFor(conversationId)
    if (text) localStorage.setItem(key, text)
    else localStorage.removeItem(key)
  } catch {
    // Storage full/unavailable — the draft just won't survive restart; not worth surfacing.
  }
}
