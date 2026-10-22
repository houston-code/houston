/**
 * Conversations with a rewind (or its undo) in flight. Its own module so the loop can
 * refuse to start a run mid-rewind without importing rewind.ts, which imports the loop.
 */
const inFlight = new Set<string>()

export function rewindInProgress(conversationId: string): boolean {
  return inFlight.has(conversationId)
}

/** Run `work` holding the conversation's rewind lock; refuse when it's already held. */
export async function withRewindLock<T>(
  conversationId: string,
  busy: T,
  work: () => Promise<T>
): Promise<T> {
  if (inFlight.has(conversationId)) return busy
  inFlight.add(conversationId)
  try {
    return await work()
  } finally {
    inFlight.delete(conversationId)
  }
}
