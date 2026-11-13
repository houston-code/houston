import { realpathSync } from 'node:fs'
import { getSettings } from './store'
import { listConversations } from './conversations'

/**
 * Whether `workspace` is a project folder the app already knows: one of the recent
 * projects or a chat's folder (a chat in a worktree has the worktree as its folder).
 * Actions that write to a repository from the UI (commit, push) check this, so a
 * renderer bug can't point them at an arbitrary folder. Compared by real path.
 */
export function isKnownWorkspace(workspace: string): boolean {
  let real: string
  try {
    real = realpathSync(workspace)
  } catch {
    return false
  }
  const candidates = [...(getSettings().recentWorkspaces ?? []), ...listConversations().map((c) => c.workspace)]
  return candidates.some((c) => {
    try {
      return typeof c === 'string' && realpathSync(c) === real
    } catch {
      return false
    }
  })
}
