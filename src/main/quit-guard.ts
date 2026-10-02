/**
 * Quitting (⌘Q or menu → Quit), or restarting to install an update, while work is
 * still live would silently tear it down: chats abort their in-flight runs and drop
 * queued input, and background tasks (integrated terminals, commands the agent
 * backgrounded) are killed. The main process intercepts both and, when anything is
 * live, asks for confirmation first. The decision and the wording live here as pure
 * functions so they can be unit-tested without Electron; the imperative dialog
 * wiring stays in quit-confirm.ts.
 */

/** What's still running when the user asks to quit or restart. */
export interface LiveWork {
  /** Conversations with a live agent run. */
  chats: number
  /** Running background tasks: live terminals + running backgrounded shells. */
  tasks: number
}

/** Why the app is about to go away: a plain quit, or a restart to install an update. */
export type QuitReason = 'quit' | 'restart'

/** Whether a quit/restart should pause for confirmation given what's live. */
export function shouldConfirmQuit(work: LiveWork): boolean {
  return work.chats > 0 || work.tasks > 0
}

function count(n: number, one: string, many: string): string {
  return n === 1 ? one : `${n} ${many}`
}

/** "a chat", "2 chats and a background task", … (lower-case, no verb). */
function livePhrase(work: LiveWork): string {
  const parts: string[] = []
  if (work.chats > 0) parts.push(count(work.chats, 'a chat', 'chats'))
  if (work.tasks > 0) parts.push(count(work.tasks, 'a background task', 'background tasks'))
  return parts.join(' and ')
}

/** The confirmation dialog's headline, e.g. "2 chats and a background task are still running." */
export function quitConfirmMessage(work: LiveWork): string {
  const phrase = livePhrase(work)
  const verb = work.chats + work.tasks === 1 ? 'is' : 'are'
  return `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)} ${verb} still running.`
}

/** The confirmation dialog's body: what quitting/restarting now will do. Plural-aware. */
export function quitConfirmDetail(work: LiveWork, reason: QuitReason = 'quit'): string {
  const object = work.chats + work.tasks === 1 ? 'it' : 'them'
  const action = reason === 'restart' ? 'Restarting to install the update' : 'Quitting'
  return `${action} now will stop ${object} and discard any unsaved progress.`
}

/** The confirming button's label. */
export function quitConfirmButton(reason: QuitReason): string {
  return reason === 'restart' ? 'Restart anyway' : 'Quit anyway'
}
