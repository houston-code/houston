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
