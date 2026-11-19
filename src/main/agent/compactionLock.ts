import { hasBackgroundNews, requestWake } from './backgroundEvents'

/**
 * Manual compactions (`/compact`, Summarize from here / up to here) in flight, by
 * conversation id, each with the controller that cancels it. Its own module so the
 * wake path can refuse to start a turn mid-compaction without importing compact.ts,
 * which imports the loop: a turn started meanwhile makes the finished summary
 * unwritable, so it would be thrown away.
 */
const inFlight = new Map<string, AbortController>()

/** Whether a compaction of the conversation is in flight. */
export function compactionInProgress(id: string): boolean {
  return inFlight.has(id)
}

/** The in-flight compaction's controller, if there is one. */
export function compactionController(id: string): AbortController | undefined {
  return inFlight.get(id)
}

/** Mark a compaction of `id` in flight; false when one already is. */
export function holdCompaction(id: string, ctl: AbortController): boolean {
  if (inFlight.has(id)) return false
  inFlight.set(id, ctl)
  return true
}

/** End the compaction of `id`, and ask again for a wake it held back. */
export function releaseCompaction(id: string): void {
  inFlight.delete(id)
  // A wake refused while the compaction held the chat left its news waiting.
  if (hasBackgroundNews(id)) requestWake(id)
}
