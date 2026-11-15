import { isAbsolute, relative, resolve } from 'node:path'
import type { DeleteConversationResult } from '@shared/agent'
import type { DeletePlan } from './deleteChat'

/** A delete plan as the terminal words it: `inSession` when the session runs in the worktree. */
export type TuiDeletePlan = DeletePlan & { inSession?: boolean }

/**
 * The plan for deleting a chat from a session that runs in `cwd`. When `cwd` is the
 * chat's worktree (or a folder inside it), the worktree is never offered for removal:
 * removing it would pull the folder out from under the session, so every later turn,
 * `!` command and new chat would point at a folder that no longer exists. The chat is
 * deleted as a plain one and the worktree stays. Pure.
 */
export function planForSession(plan: DeletePlan, cwd: string): TuiDeletePlan {
  const path = plan.worktree?.path
  if (!path || plan.kind === 'plain') return plan
  const rel = relative(resolve(path), resolve(cwd))
  const inside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  return inside ? { ...plan, kind: 'plain', inSession: true } : plan
}

/**
 * The terminal's /delete confirmation, worded like the desktop's delete dialog and
 * offering the same choices: a chat whose worktree holds work can keep it or remove
 * it, a clean and merged worktree goes with the chat, and one another chat still
 * uses is never offered for removal. Anything but a clear yes keeps everything.
 */
export function deletePromptText(plan: TuiDeletePlan, title: string, messages: string): string {
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
  if (plan.inSession && plan.worktree) {
    return `${head} This cannot be undone. Its worktree on branch "${branch}" stays, because this session runs in it. [y/N] `
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
export function deleteWorktreeOutcome(plan: TuiDeletePlan, result: DeleteConversationResult | void): string {
  const wt = plan.worktree
  if (!wt) return ''
  if (plan.inSession) return `kept its worktree at ${wt.path} (branch "${wt.branch}"), the folder this session runs in`
  if (plan.shared) return `its worktree on branch "${wt.branch}" stays, another chat still uses it`
  const removal = result ? result.worktree : null
  if (!removal) return `kept its worktree at ${wt.path} (branch "${wt.branch}")`
  if (!removal.removed) return removal.message ?? `kept its worktree at ${wt.path}`
  return removal.branchDeleted
    ? `removed its worktree and branch "${wt.branch}"`
    : (removal.message ?? `removed its worktree, kept branch "${wt.branch}"`)
}
