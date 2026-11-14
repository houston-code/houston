/**
 * Stop handles for the dispatched subagents that are running right now, so a client can
 * stop one agent without stopping the turn that dispatched it (the terminal's `/tasks
 * kill`). Each dispatch runs under its own AbortController, linked to the run's, and
 * registers that controller here for as long as it runs.
 *
 * Keyed by run id plus the agent's record id (`sa1`, `sa2`, ...): record ids are only
 * unique within a run, and both arrive on every `subagent_*` event, so the client names
 * an agent exactly as it saw it. A nested agent has its own entry; stopping its parent
 * stops it too, through the linked signal.
 */

/**
 * The abort reason of a user's stop. AbortSignal.any passes its source's reason on, so a
 * nested agent stopped with its parent sees it too, while Stop and a run's end (which
 * stops background agents) abort with a different reason.
 */
export const USER_SUBAGENT_STOP: unique symbol = Symbol('subagent stopped by the user')

/** Whether an abort reason is a user's stop of this agent or one of its parents. */
export function isUserSubagentStop(reason: unknown): boolean {
  return reason === USER_SUBAGENT_STOP
}

const stops = new Map<string, () => void>()

const keyOf = (runId: string, recordId: string): string => `${runId}\u0000${recordId}`

/**
 * Register how to stop a running agent. Returns the unregister function, which the
 * dispatch calls when the agent ends, however it ends.
 */
export function registerSubagentStop(runId: string, recordId: string, stop: () => void): () => void {
  const key = keyOf(runId, recordId)
  stops.set(key, stop)
  return () => {
    if (stops.get(key) === stop) stops.delete(key)
  }
}

/**
 * Stop one running subagent. True when it was running and has been asked to stop (it
 * ends at its next check, handing back what it had); false when no running agent has
 * that id (it already finished, or it is a reviewer, which only stops with its review).
 */
export function stopSubagent(runId: string, recordId: string): boolean {
  const stop = stops.get(keyOf(runId, recordId))
  if (!stop) return false
  stops.delete(keyOf(runId, recordId))
  stop()
  return true
}

/** Whether a running subagent can be stopped on its own. */
export function canStopSubagent(runId: string, recordId: string): boolean {
  return stops.has(keyOf(runId, recordId))
}
