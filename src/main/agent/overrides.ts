import type { ToolKind } from './tools'

/**
 * "Allow for run" consent, scoped to a conversation and to a tool KIND.
 *
 * - Conversation-scoped: the grant survives across the turns of one chat, so the
 *   user isn't re-prompted for the same kind on every message. (A "run" is a single
 *   turn; without this the consent would evaporate the moment the turn ended.)
 * - Per-kind: granting one kind (say, a file write) does NOT silently also allow
 *   network egress or MCP — each kind needs its own "Allow for run". This keeps a
 *   single approval from quietly widening into a blanket pass for the whole run.
 *
 * Deliberately in-memory only: this is a soft, session-lived grant, not a saved
 * preference. A fresh app launch starts clean. The PERSISTENT path is an
 * "Always allow" permission rule (see store.addPermissionRule).
 */
export interface ConversationOverride {
  /** Tool kinds the user has granted "Allow for run" on, this conversation. */
  kinds: Set<ToolKind>
  /**
   * Conscious consent to keep running UNCONFINED shell — only relevant on a host
   * with no enforceable sandbox, where a generic kind grant is not enough (see
   * RunState.shellUnsandboxedOverride).
   */
  unsandboxedShell: boolean
}

const store = new Map<string, ConversationOverride>()

/** A fresh, empty override — for a headless run, or a conversation with no grants yet. */
export function emptyOverride(): ConversationOverride {
  return { kinds: new Set(), unsandboxedShell: false }
}

/**
 * The override a run should start from: a COPY of the conversation's accumulated
 * grants, so the run can extend its own set without retroactively mutating the
 * stored one mid-call. Empty for a headless run (no conversationId).
 */
export function overrideForConversation(conversationId: string | undefined): ConversationOverride {
  const stored = conversationId ? store.get(conversationId) : undefined
  if (!stored) return emptyOverride()
  return { kinds: new Set(stored.kinds), unsandboxedShell: stored.unsandboxedShell }
}

/**
 * Record an "Allow for run" grant so later turns of the same conversation inherit
 * it. A no-op for a headless run — there's no conversation to remember it on (the
 * grant still applies within the live run via RunState.override).
 */
export function grantConversationOverride(
  conversationId: string | undefined,
  kind: ToolKind,
  unsandboxedShell: boolean
): void {
  if (!conversationId) return
  const cur = store.get(conversationId) ?? emptyOverride()
  cur.kinds.add(kind)
  if (unsandboxedShell) cur.unsandboxedShell = true
  store.set(conversationId, cur)
}

/** Forget a conversation's grants (e.g. when the conversation is deleted). */
export function clearConversationOverride(conversationId: string): void {
  store.delete(conversationId)
}
