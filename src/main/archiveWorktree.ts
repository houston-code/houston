import type { ConversationWorktree, WorktreeRemoval } from '@shared/agent'

/**
 * Archiving a chat removes its Houston-created worktree when that loses nothing: no
 * uncommitted or untracked changes, and a branch already merged (into the main
 * checkout's HEAD or origin's default branch). Each chat worktree is a full checkout,
 * and archived chats' worktrees otherwise pile up on disk for good.
 *
 * Left alone: a worktree another chat still uses (a fork shares its source's), one
 * whose chat has a live run or running background shells, and anything with doubt.
 * After removal the chat points at the repo root, so unarchiving it still works.
 */
export interface ArchiveWorktreeDeps {
  /** The chat's archived flag and worktree, without loading its messages. */
  peek(id: string): { worktree?: ConversationWorktree; archived?: boolean } | undefined
  /** How many other chats run in the worktree at `path`. */
  sharedCount(id: string, path: string): number
  /** Whether the chat has a live run or running background shells. */
  busy(id: string): boolean
  isDisposable(wt: ConversationWorktree): Promise<boolean>
  remove(wt: ConversationWorktree): Promise<WorktreeRemoval>
  /** Point the chat at `repoRoot` and drop its worktree record. */
  detach(id: string, repoRoot: string): void
}

/** What was removed, or null when the worktree was left. Never throws. */
export async function removeWorktreeOnArchive(
  id: string,
  deps: ArchiveWorktreeDeps
): Promise<WorktreeRemoval | null> {
  try {
    const conv = deps.peek(id)
    const wt = conv?.worktree
    if (!wt || !conv.archived) return null
    if (deps.sharedCount(id, wt.path) > 0 || deps.busy(id)) return null
    if (!(await deps.isDisposable(wt))) return null
    // The check took a moment: skip if the chat was unarchived or started work since.
    const now = deps.peek(id)
    if (!now?.archived || now.worktree?.path !== wt.path || deps.busy(id)) return null
    const res = await deps.remove(wt)
    if (res.removed) deps.detach(id, wt.repoRoot)
    return res
  } catch {
    return null
  }
}
