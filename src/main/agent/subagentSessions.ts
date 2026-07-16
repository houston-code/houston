import type { ChatMessage } from '@shared/agent'

/**
 * In-memory transcripts of completed subagent dispatches, so the main agent can
 * send a follow-up into an agent's context instead of re-dispatching from
 * scratch (the `resume` parameter on dispatch_agent / dispatch_writable_agent).
 *
 * Keyed by conversation (falling back to runId for conversation-less runs), so
 * an id handed to the model in one turn stays valid across later turns of the
 * same chat. Deliberately NOT persisted: a transcript embeds tool results from a
 * live workspace, so replaying one across app restarts risks acting on stale
 * state — the model is told ids last for the app session. Memory is bounded by
 * evicting the oldest transcript per conversation past a small cap.
 */

export interface SubAgentSession {
  /** Short handle the model uses to resume ("ag1", "ag2", …), unique per conversation. */
  id: string
  /** The completed run's full message log (every tool call paired with its result). */
  messages: ChatMessage[]
  /** Tier the agent ran under; a resume must come through the same dispatch tool. */
  writable: boolean
  /** The custom agent it ran as, when one was named. */
  agentName?: string
  /** Model the agent ran on — a resume stays on it so the context reads consistently. */
  model: string
  /** The custom agent's system prompt / tool narrowing, replayed verbatim on resume. */
  systemOverride?: string
  tools?: string[]
}

/** Most transcripts kept per conversation; the oldest is evicted past this. */
export const MAX_SUBAGENT_SESSIONS = 8

interface ConversationSessions {
  /** Monotonic counter so ids stay unique even after evictions. */
  counter: number
  sessions: Map<string, SubAgentSession>
}

const byConversation = new Map<string, ConversationSessions>()

/**
 * Store a completed dispatch's transcript and return the id the model can use to
 * resume it. Evicts the oldest stored transcript once the per-conversation cap is
 * exceeded (ids are never reused — the counter only grows).
 */
export function rememberSubAgent(
  conversationKey: string,
  entry: Omit<SubAgentSession, 'id'>
): string {
  let conv = byConversation.get(conversationKey)
  if (!conv) {
    conv = { counter: 0, sessions: new Map() }
    byConversation.set(conversationKey, conv)
  }
  conv.counter += 1
  const id = `ag${conv.counter}`
  conv.sessions.set(id, { ...entry, id })
  if (conv.sessions.size > MAX_SUBAGENT_SESSIONS) {
    // Map preserves insertion order, so the first key is the oldest transcript.
    const oldest = conv.sessions.keys().next().value
    if (oldest !== undefined) conv.sessions.delete(oldest)
  }
  return id
}

/** Look up a stored transcript, or undefined for an unknown/evicted/expired id. */
export function getSubAgent(conversationKey: string, id: string): SubAgentSession | undefined {
  return byConversation.get(conversationKey)?.sessions.get(id)
}

/**
 * Replace a resumed agent's stored transcript with the continued run's log. The
 * entry keeps its id and re-enters the eviction order as the most recent.
 */
export function updateSubAgentMessages(
  conversationKey: string,
  id: string,
  messages: ChatMessage[]
): void {
  const conv = byConversation.get(conversationKey)
  const entry = conv?.sessions.get(id)
  if (!conv || !entry) return
  conv.sessions.delete(id)
  conv.sessions.set(id, { ...entry, messages })
}

/** Test-only: drop every stored transcript so suites can't leak state into each other. */
export function resetSubAgentSessions(): void {
  byConversation.clear()
}
