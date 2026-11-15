import type { ConversationWorktree, DeleteConversationResult, WorktreeRemoval } from '@shared/agent'
import { activeRunForConversation, cancelRun } from './agent/loop'
import { forgetQueue } from './agent/queue'
import { killShellsFor } from './agent/shells'
import { isWorktreeDisposable, removeWorktree } from './agent/worktree'
import { deleteConversation, otherConversationsInWorktree, peekConversation } from './conversations'

/**
 * Delete a chat and stop what it still has running, the same way from every client:
 * its live run (which would otherwise keep writing to a deleted chat), its background
 * shells (whose dev servers would keep their ports), and its queued input. How a
 * client asks before a delete (the desktop's dialog, the terminal's prompt) is the
 * client's own; what the worktree choices are and what they do is `deleteChat`'s.
 */
export function stopAndDeleteConversation(id: string): void {
  const liveRun = activeRunForConversation(id)
  if (liveRun) cancelRun(liveRun)
  killShellsFor(id)
  deleteConversation(id)
  // The cached queue went with the file, and must not linger in memory.
  forgetQueue(id)
}

/**
 * Which delete confirmation a chat gets: a plain chat, a chat whose worktree holds
 * work (keep/remove choice), or a chat whose worktree is clean and merged (plain
 * confirmation that also tears the worktree down, since nothing is lost).
 */
export type DeleteDialogKind = 'plain' | 'worktree' | 'disposableWorktree'

/**
 * Translate a delete-confirmation button index into what should happen.
 * Button 0 is always Cancel (in every dialog), so a cancel can never delete: the
 * bug this guards against. The worktree dialog's button 2 ("Delete & remove
 * worktree") tears the worktree down; a disposable worktree goes with the chat.
 */
export function resolveDeleteAction(
  kind: DeleteDialogKind,
  response: number
): { delete: boolean; removeWorktree: boolean } {
  if (response === 0) return { delete: false, removeWorktree: false }
  const removeWorktree =
    kind === 'disposableWorktree' || (kind === 'worktree' && response === 2)
  return { delete: true, removeWorktree }
}

/** What deleting a chat would do to its worktree, for the client to ask about. */
export interface DeletePlan {
  kind: DeleteDialogKind
  /** The chat's title, when it has one. */
  title?: string
  /** The chat's worktree, when it has one (also for `plain`, when another chat shares it). */
  worktree?: ConversationWorktree
  /** True when another chat still runs in the worktree, so it is never offered for removal. */
  shared: boolean
}

export interface DeleteChatDeps {
  peek(id: string): { title?: string; worktree?: ConversationWorktree } | null | undefined
  sharedCount(id: string, path: string): number
  isDisposable(wt: ConversationWorktree): Promise<boolean>
  removeWorktree(wt: ConversationWorktree): Promise<WorktreeRemoval>
  stopAndDelete(id: string): void
}

const defaultDeps: DeleteChatDeps = {
  // Only the title and worktree are needed: no attachment bytes.
  peek: (id) => peekConversation(id),
  sharedCount: otherConversationsInWorktree,
  isDisposable: (wt) => isWorktreeDisposable(wt),
  removeWorktree: (wt) => removeWorktree(wt),
  stopAndDelete: stopAndDeleteConversation
}

/**
 * Work out which confirmation a chat's delete needs. A worktree another chat still
 * runs in (a fork shares its source's) is never offered for removal, even when it
 * looks disposable. Never throws: any doubt about the worktree keeps the choice.
 */
export async function planChatDelete(id: string, deps: DeleteChatDeps = defaultDeps): Promise<DeletePlan> {
  const conv = deps.peek(id)
  const wt = conv?.worktree
  const title = conv?.title
  if (!wt) return { kind: 'plain', title, shared: false }
  const shared = deps.sharedCount(id, wt.path) > 0
  if (shared) return { kind: 'plain', title, worktree: wt, shared }
  const disposable = await deps.isDisposable(wt).catch(() => false)
  return { kind: disposable ? 'disposableWorktree' : 'worktree', title, worktree: wt, shared }
}

/**
 * Delete a chat the user confirmed, stopping what it still runs, and tear down its
 * worktree when `removeWorktree` is set and the plan allowed it (never a shared one).
 * The removal itself is git's safe one: uncommitted or unmerged work is kept.
 */
export async function deleteChat(
  id: string,
  plan: DeletePlan,
  removeWorktree: boolean,
  deps: DeleteChatDeps = defaultDeps
): Promise<DeleteConversationResult> {
  // Stop what the chat still has running before it goes: its background shells'
  // dev servers would otherwise hold their ports inside a worktree about to go.
  deps.stopAndDelete(id)
  const wt = plan.worktree
  const worktree = removeWorktree && wt && !plan.shared && plan.kind !== 'plain' ? await deps.removeWorktree(wt) : null
  return { deleted: true, worktree }
}
