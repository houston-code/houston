/**
 * Background shells and the dev servers they start belong to the chat whose agent run
 * started them. The Tasks and Preview panels show only the open chat's, so switching
 * chats doesn't surface another chat's servers. Something with no owning chat (started
 * outside a conversation) shows everywhere. A new, unsaved chat (`currentId` null)
 * owns nothing yet.
 */
export function ownedByChat<T extends { conversationId?: string }>(
  items: readonly T[],
  currentId: string | null
): T[] {
  return items.filter((it) => !it.conversationId || it.conversationId === currentId)
}
