import type { DeleteConversationResult } from '@shared/agent'
import type { DeletePlan } from './deleteChat'

/**
 * The terminal's /delete confirmation, worded like the desktop's delete dialog and
 * offering the same choices: a chat whose worktree holds work can keep it or remove
 * it, a clean and merged worktree goes with the chat, and one another chat still
 * uses is never offered for removal. Anything but a clear yes keeps everything.
 */
export function deletePromptText(plan: DeletePlan, title: string, messages: string): string {
  const branch = plan.worktree?.branch ?? ''
  const head = `Delete "${title}" and its ${messages}?`
  if (plan.kind === 'worktree') {
    return (
      `${head} It has a git worktree on branch "${branch}".\n` +
      '  k: delete, keep the worktree on disk\n' +
      '  r: delete and remove the worktree (uncommitted or unmerged work is kept)\n' +
      '[k/r/N] '
    )
  }
  if (plan.kind === 'disposableWorktree') {
    return (
      `${head} Its worktree on branch "${branch}" has no changes or unmerged commits, ` +
      'so it will be removed too. This cannot be undone. [y/N] '
    )
  }
  if (plan.shared && plan.worktree) {
    return `${head} This cannot be undone. Its worktree on branch "${branch}" stays, because another chat still uses it. [y/N] `
  }
  return `${head} This cannot be undone. [y/N] `
}

/** Read the answer to `deletePromptText`. Empty, unknown or cancelled: nothing happens. */
export function parseDeleteAnswer(
  plan: DeletePlan,
  answer: string | null | undefined
): { delete: boolean; removeWorktree: boolean } {
  const a = (answer ?? '').trim().toLowerCase()
  if (plan.kind === 'worktree') {
    if (a === 'k' || a === 'keep') return { delete: true, removeWorktree: false }
    if (a === 'r' || a === 'remove') return { delete: true, removeWorktree: true }
    return { delete: false, removeWorktree: false }
  }
  if (a === 'y' || a === 'yes') return { delete: true, removeWorktree: plan.kind === 'disposableWorktree' }
  return { delete: false, removeWorktree: false }
}

/**
 * What became of the worktree, as a line for the transcript (empty when the chat had
 * none). Says plainly when the worktree or its branch stayed, and why.
 */
export function deleteWorktreeOutcome(plan: DeletePlan, result: DeleteConversationResult | void): string {
  const wt = plan.worktree
  if (!wt) return ''
  if (plan.shared) return `its worktree on branch "${wt.branch}" stays, another chat still uses it`
  const removal = result ? result.worktree : null
  if (!removal) return `kept its worktree at ${wt.path} (branch "${wt.branch}")`
  if (!removal.removed) return removal.message ?? `kept its worktree at ${wt.path}`
  return removal.branchDeleted
    ? `removed its worktree and branch "${wt.branch}"`
    : (removal.message ?? `removed its worktree, kept branch "${wt.branch}"`)
}
