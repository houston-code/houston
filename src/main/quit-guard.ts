/**
 * Quitting (⌘Q or menu → Quit) while one or more chats are still running would
 * silently abort their in-flight runs and drop any queued input. The main process
 * intercepts the quit and, when runs are live, asks for confirmation first. The
 * decision and the wording live here as pure functions so they can be unit-tested
 * without Electron; the imperative dialog wiring stays in index.ts.
 */

/** Whether a quit should pause for confirmation given how many runs are live. */
export function shouldConfirmQuit(runningCount: number): boolean {
  return runningCount > 0
}

/** The confirmation dialog's body when quitting with live runs. Plural-aware. */
export function quitConfirmDetail(runningCount: number): string {
  const subject = runningCount === 1 ? 'A chat is' : `${runningCount} chats are`
  const object = runningCount === 1 ? 'it' : 'them'
  return `${subject} still running. Quitting now will stop ${object} and discard any unsaved progress.`
}
