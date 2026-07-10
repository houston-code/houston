import type { ChatMessage } from '@shared/agent'

/**
 * Placeholder result for a tool call that was never run because the turn was
 * interrupted — the app quit or crashed, or the run was stopped — while the call
 * was still pending (most commonly parked on an approval prompt).
 */
export const INTERRUPTED_TOOL_RESULT =
  'No result: the previous turn was interrupted before this tool produced output. Re-issue the call if its result is still needed.'

/**
 * Synthetic `tool` results needed to make a message log valid again after an
 * interruption — one per dangling tool call in the final assistant turn.
 *
 * The loop persists an assistant message (with its `toolCalls`) *before* running
 * the calls, so a turn interrupted mid-tool leaves a `tool_use` with no matching
 * `tool_result`. Providers like Anthropic reject any history where a `tool_use`
 * block isn't immediately followed by its `tool_result`, so such a conversation
 * can never be sent again — every continue/retry 400s — until the gap is filled.
 *
 * Only the last tool-calling assistant turn is examined: an interruption can only
 * truncate the tail (the live loop keeps every earlier turn balanced), so any
 * unanswered call is necessarily trailing and its placeholder belongs at the end.
 * A turn that already has all its results yields `[]` (the happy path allocates
 * nothing past the empty array).
 */
export function missingToolResults(messages: ChatMessage[]): ChatMessage[] {
  let assistantIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'assistant' && (m.toolCalls?.length ?? 0) > 0) {
      assistantIdx = i
      break
    }
  }
  if (assistantIdx === -1) return []

  const answered = new Set<string>()
  for (let i = assistantIdx + 1; i < messages.length; i++) {
    const m = messages[i]
    if (m.role === 'tool' && m.toolCallId) answered.add(m.toolCallId)
  }

  return (messages[assistantIdx].toolCalls ?? [])
    .filter((c) => !answered.has(c.id))
    .map((c) => ({
      role: 'tool' as const,
      content: INTERRUPTED_TOOL_RESULT,
      toolCallId: c.id,
      toolName: c.name
    }))
}

/**
 * Normalize a message log so every `tool_use` is IMMEDIATELY followed by its
 * `tool_result`, which is what providers require. Two things get fixed:
 *
 * 1. A dangling call (no result anywhere) gets an {@link INTERRUPTED_TOOL_RESULT}
 *    placeholder inserted right after its assistant turn.
 * 2. A result that exists but was displaced — separated from its `tool_use` by
 *    another message — is pulled back up to immediately follow that turn.
 *
 * Unlike {@link missingToolResults} (which only appends placeholders for the trailing
 * turn), this handles a dangling call ANYWHERE in the log. That matters for tools that
 * block on the user for a long time — `present_plan`, `ask_user` — where the app can
 * quit with the call pending, the user then sends another message (appended AFTER the
 * dangling `tool_use`), and a naive tail-append would drop the placeholder after that
 * user message, leaving the `tool_use` still un-paired. It also repairs logs a prior
 * tail-append already corrupted this way (a stray result stranded after a user turn).
 *
 * Returns the SAME array reference when nothing needed moving (so callers can cheaply
 * detect a no-op), otherwise a new, balanced array.
 */
export function repairDanglingToolResults(messages: ChatMessage[]): ChatMessage[] {
  // callId -> its result message (each id is produced by exactly one tool_use).
  const resultByCallId = new Map<string, ChatMessage>()
  for (const m of messages) {
    if (m.role === 'tool' && m.toolCallId && !resultByCallId.has(m.toolCallId)) {
      resultByCallId.set(m.toolCallId, m)
    }
  }

  const out: ChatMessage[] = []
  const placed = new Set<string>()
  for (const m of messages) {
    // A tool result is emitted alongside its assistant turn (below); skip it in its
    // original slot so it isn't duplicated or left stranded in a displaced position.
    if (m.role === 'tool' && m.toolCallId && placed.has(m.toolCallId)) continue

    out.push(m)
    if (m.role === 'assistant' && (m.toolCalls?.length ?? 0) > 0) {
      for (const c of m.toolCalls ?? []) {
        const existing = resultByCallId.get(c.id)
        out.push(
          existing ?? {
            role: 'tool',
            content: INTERRUPTED_TOOL_RESULT,
            toolCallId: c.id,
            toolName: c.name
          }
        )
        placed.add(c.id)
      }
    }
  }

  // Same objects, order, and length ⇒ nothing changed; return the original reference.
  if (out.length === messages.length && out.every((m, i) => m === messages[i])) return messages
  return out
}
