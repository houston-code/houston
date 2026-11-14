/**
 * The composer's unsent draft, persisted to localStorage so text typed but not
 * yet sent survives an app restart. Renderer-only, like the prompt history
 * (see promptHistory.ts) — no main-process round-trip, and Chromium-backed
 * localStorage persists across restarts on macOS, Linux and Windows alike.
 *
 * Drafts are keyed per conversation, so each chat keeps its own lingering text
 * in isolation — a draft left in one chat never shows up in another, and every
 * chat's draft survives a restart. The not-yet-created "new chat" composer gets
 * its own slot. The text and the context chips (a folded paste, an attached or
 * dropped file, a folder listing, the diff, a link) are persisted; pending image
 * attachments are not (they can be large and would risk the localStorage quota).
 * Context chips are plain text but can add up: past MAX_SAVED_CONTEXT_CHARS (or
 * when storage refuses them) their content is folded into the saved text instead,
 * exactly as it would have been sent, so a restored draft never loses it.
 */

import {
  buildMessageWithContext,
  MAX_CONTEXT_ATTACHMENTS,
  type ContextAttachment,
  type ContextKind
} from '@shared/composerContext'

const PREFIX = 'houston.composerDraft'
const CONTEXT_PREFIX = 'houston.composerDraftContext'

/** Above this many serialized characters, saved chips are inlined into the draft text. */
export const MAX_SAVED_CONTEXT_CHARS = 1_000_000

const KINDS: ReadonlySet<string> = new Set<ContextKind>(['file', 'folder', 'diff', 'link', 'paste'])

/** Storage key for a conversation's draft; the new-chat composer gets its own slot. */
function keyFor(conversationId: string | null): string {
  return `${PREFIX}:${conversationId ?? 'new'}`
}

/** Storage key for a conversation's draft context chips. */
function contextKeyFor(conversationId: string | null): string {
  return `${CONTEXT_PREFIX}:${conversationId ?? 'new'}`
}

/** Load a conversation's saved draft, tolerating absent/unavailable storage (→ ''). */
export function loadComposerDraft(conversationId: string | null): string {
  try {
    return localStorage.getItem(keyFor(conversationId)) ?? ''
  } catch {
    return ''
  }
}

function isContextAttachment(v: unknown): v is ContextAttachment {
  if (!v || typeof v !== 'object') return false
  const a = v as Record<string, unknown>
  return (
    typeof a.id === 'string' &&
    typeof a.kind === 'string' &&
    KINDS.has(a.kind) &&
    typeof a.label === 'string' &&
    typeof a.text === 'string' &&
    (a.detail === undefined || typeof a.detail === 'string')
  )
}

/** Load a conversation's saved context chips; absent or malformed storage reads as none. */
export function loadComposerContext(conversationId: string | null): ContextAttachment[] {
  try {
    const raw = localStorage.getItem(contextKeyFor(conversationId))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isContextAttachment).slice(0, MAX_CONTEXT_ATTACHMENTS)
  } catch {
    return []
  }
}

/**
 * Persist a conversation's draft (its text plus any context chips), or clear it
 * when empty so storage stays tidy.
 */
export function saveComposerDraft(
  conversationId: string | null,
  text: string,
  context: readonly ContextAttachment[] = []
): void {
  let savedText = text
  try {
    const ctxKey = contextKeyFor(conversationId)
    if (context.length === 0) {
      localStorage.removeItem(ctxKey)
    } else {
      const json = JSON.stringify(context)
      let stored = false
      if (json.length <= MAX_SAVED_CONTEXT_CHARS) {
        try {
          localStorage.setItem(ctxKey, json)
          stored = true
        } catch {
          // Quota: fall through and inline the content into the text instead.
        }
      }
      if (!stored) {
        localStorage.removeItem(ctxKey)
        savedText = buildMessageWithContext(text, [...context])
      }
    }
  } catch {
    // Storage unavailable: the text write below won't stick either.
  }
  try {
    const key = keyFor(conversationId)
    if (savedText) localStorage.setItem(key, savedText)
    else localStorage.removeItem(key)
  } catch {
    // Storage full/unavailable — the draft just won't survive restart; not worth surfacing.
  }
}
