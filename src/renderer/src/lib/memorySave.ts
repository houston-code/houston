import type { MemoryScope } from '@shared/memory'

type Notify = (text: string, tone?: 'info' | 'error') => void
type Save = (workspace: string, scope: MemoryScope, text: string) => Promise<string | null>

/**
 * Save a `#` note and tell the user how it went: where it landed, that the input
 * wasn't savable (main returns null), or that the write failed (main throws: the
 * file busy in another Houston window, no permission). Before, a failed write
 * rejected unhandled and the user saw nothing.
 */
export async function saveMemoryAndNotify(
  save: Save,
  notify: Notify,
  workspace: string,
  scope: MemoryScope,
  text: string
): Promise<void> {
  let path: string | null
  try {
    path = await save(workspace, scope, text)
  } catch (e) {
    // Main says why (a rules file that links out of the project, the file busy in
    // another window); show that, without Electron's "Error invoking remote method".
    const reason = e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']*':\s*(?:\w*Error:\s*)?/, '') : ''
    notify(reason ? `Couldn't save that instruction: ${reason}` : "Couldn't save that instruction. Try again.", 'error')
    return
  }
  if (path) {
    notify(`Remembered: added to ${scope === 'project' ? 'this project' : 'every project'} (${path})`, 'info')
  } else {
    notify('Could not save that instruction.', 'error')
  }
}
