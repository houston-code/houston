import type { ChatMessage } from '@shared/agent'

/** Whether two user turns say the same thing: same text, attachments, and invocation. */
function sameUserTurn(a: ChatMessage, b: ChatMessage): boolean {
  return (
    a.role === 'user' &&
    b.role === 'user' &&
    a.content === b.content &&
    JSON.stringify(a.images ?? []) === JSON.stringify(b.images ?? []) &&
    JSON.stringify(a.invokedAs ?? null) === JSON.stringify(b.invokedAs ?? null)
  )
}

/**
 * Add the user's new message to a conversation's history.
 *
 * A history that ends in a user message means the turn it started produced nothing:
 * it failed before the model answered (a provider error, a model the provider doesn't
 * serve, a missing key). Sending the same message again is a retry, so it replaces
 * that message instead of stacking an identical copy the model would then read twice.
 * A different message is appended as before: the user may be adding to what they
 * asked, and adjacent user turns are folded together on the way to the provider.
 *
 * The replaced message's record of why its earlier runs got no reply moves onto the
 * resend, so retrying doesn't erase the history of what failed.
 */
export function appendUserTurn(messages: ChatMessage[], next: ChatMessage): ChatMessage[] {
  const last = messages.at(-1)
  if (last && sameUserTurn(last, next)) {
    const kept = last.unanswered?.length ? { ...next, unanswered: last.unanswered } : next
    return [...messages.slice(0, -1), kept]
  }
  return [...messages, next]
}
