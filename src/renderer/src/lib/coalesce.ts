/**
 * Wrap an async refresh so a burst of calls shares one run.
 *
 * Every caller is promised a run that starts after its own call, which is what a
 * "refetch now that I changed something" needs, but callers no longer each get a run
 * of their own:
 * - Calls made in the same tick share one run (it starts on the next microtask).
 * - A call made while a run is in flight shares one follow-up run with every other
 *   call made during that flight; the follow-up starts when the flight lands.
 *
 * So N overlapping calls cost at most two runs, never N. A run that rejects rejects
 * for the callers sharing it and does not block later ones.
 */
export function coalesced(run: () => Promise<void>): () => Promise<void> {
  /** The run that has been promised but not started yet, if any. */
  let next: Promise<void> | null = null
  /** The run currently in flight, if any. */
  let flying: Promise<void> | null = null

  return () => {
    if (next) return next
    const after = flying ? flying.catch(() => {}) : Promise.resolve()
    const mine: Promise<void> = after.then(() => {
      next = null
      flying = mine
      return run()
    })
    next = mine
    const clear = (): void => {
      if (flying === mine) flying = null
    }
    mine.then(clear, clear)
    return mine
  }
}
