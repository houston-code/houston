import { activeRunForConversation, cancelRun } from './agent/loop'
import { forgetQueue } from './agent/queue'
import { killShellsFor } from './agent/shells'
import { deleteConversation } from './conversations'

/**
 * Delete a chat and stop what it still has running, the same way from every client:
 * its live run (which would otherwise keep writing to a deleted chat), its background
 * shells (whose dev servers would keep their ports), and its queued input. What a
 * client shows around a delete (the desktop's confirmation, its worktree cleanup) is
 * the client's own.
 */
export function stopAndDeleteConversation(id: string): void {
  const liveRun = activeRunForConversation(id)
  if (liveRun) cancelRun(liveRun)
  killShellsFor(id)
  deleteConversation(id)
  // The cached queue went with the file, and must not linger in memory.
  forgetQueue(id)
}
