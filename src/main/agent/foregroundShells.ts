/**
 * The foreground `run_shell` commands running right now, so a client can move one to
 * the background without stopping the turn (the terminal's Ctrl-B). The tool call
 * then returns at once with the shell's id, the process carries on in the background
 * registry (shells.ts), and `/tasks` lists it.
 *
 * Keyed by run id plus the tool call's id: a run can have more than one command going
 * (parallel calls), and a client knows only the run it started. Each command registers
 * while it runs and unregisters when it ends, however it ends.
 */

const moves = new Map<string, Map<string, () => void>>()

/**
 * Register how to move a running foreground command to the background. Returns the
 * unregister function, which the command calls when it ends.
 */
export function registerForegroundShell(runId: string, callId: string, move: () => void): () => void {
  let calls = moves.get(runId)
  if (!calls) {
    calls = new Map()
    moves.set(runId, calls)
  }
  calls.set(callId, move)
  return () => {
    const now = moves.get(runId)
    if (now?.get(callId) !== move) return
    now.delete(callId)
    if (now.size === 0) moves.delete(runId)
  }
}

/**
 * Move every foreground command of a run to the background. Returns how many were
 * running (and have been asked to move); 0 when the run has none going.
 */
export function backgroundForegroundShells(runId: string): number {
  const calls = moves.get(runId)
  if (!calls) return 0
  moves.delete(runId)
  for (const move of calls.values()) move()
  return calls.size
}

/** Whether a run has a foreground command that could be moved to the background. */
export function hasForegroundShell(runId: string): boolean {
  return (moves.get(runId)?.size ?? 0) > 0
}
