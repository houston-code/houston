import { isSafeGitRef, suggestBranch } from '@shared/git'
import type { RepoInfo } from '@shared/agent'

/**
 * Helpers for the inline "new chat in a worktree" controls in the control bar.
 * Branch-name validity mirrors the main process's authoritative check so the
 * composer's Send button can gate on it for instant feedback.
 */

/** What the new-chat effect should do with the current workspace path. */
export type NewChatWorkspacePlan =
  /** The path no longer exists on disk — clear it and fall back to the picker. */
  | { action: 'drop' }
  /** The path is a linked worktree's root — re-point at the repo's main root. */
  | { action: 'reanchor'; root: string }
  /** Honor the path as-is; `worktreeDefault` seeds the worktree toggle. */
  | { action: 'keep'; worktreeDefault: boolean }

/**
 * Decide how a not-yet-started chat treats its workspace path. Only a path that
 * IS a linked worktree's root gets silently re-anchored to the repo's main
 * worktree — that path is app-inherited state (a "New chat" opened from a
 * worktree-backed chat), and anchoring there would base the branch picker on
 * that chat's branch and nest the new checkout inside a per-chat dir. A
 * deliberately-picked subdirectory is kept, with the worktree toggle defaulting
 * off: creating a worktree would immediately move the chat to the fresh
 * checkout's root, silently un-scoping the pick. Non-repo folders are kept
 * (toggle off), and a path that vanished from disk is dropped. A repo whose
 * current branch has no commits yet also defaults the toggle off: without a
 * commit there is nothing to branch from unless another branch is picked. Pure.
 */
export function planNewChatWorkspace(info: RepoInfo, workspace: string): NewChatWorkspacePlan {
  if (!info.exists) return { action: 'drop' }
  const norm = (p: string): string => p.replace(/\/+$/, '')
  if (info.isRepo && info.root && info.isLinkedWorktreeRoot && norm(info.root) !== norm(workspace)) {
    return { action: 'reanchor', root: info.root }
  }
  const isSubdir = info.isRepo && !!info.root && norm(info.root) !== norm(workspace)
  return { action: 'keep', worktreeDefault: info.isRepo && !isSubdir && !info.unborn }
}

/**
 * The folder a new chat opened from `chat` starts in. A chat in a Houston worktree
 * hands over its repo's root, not its own checkout: the new chat belongs to the
 * project, and starting from the checkout would show that per-chat folder until the
 * git lookup re-anchored it (see {@link planNewChatWorkspace}). Pure.
 */
export function newChatFolder(chat: { workspace: string; worktree?: { repoRoot: string } }): string {
  return chat.worktree?.repoRoot || chat.workspace
}

/**
 * Whether a new chat's "New worktree" toggle starts on: where the planner would turn
 * it on (a repo root with commits), unless the user has said they don't want it.
 */
export function initialWorktreeMode(planDefault: boolean, preference: boolean | undefined): boolean {
  return planDefault && preference !== false
}

/**
 * Whether a new worktree can be branched at all: needs some commit to start from,
 * i.e. a born current branch (or detached HEAD) or another branch with commits.
 */
export function canCreateWorktree(info: RepoInfo): boolean {
  return info.isRepo && (!info.unborn || info.branches.length > 0)
}

/**
 * The base the picker starts on: the repo's mainline (`main`), so a new worktree
 * doesn't inherit whatever branch the main checkout happens to have out. Without
 * one, the current branch. Must be a value the picker actually lists, or the
 * select shows its first option while sending a different (empty) base. An unborn
 * current branch isn't listed, so it falls back to the newest branch with commits.
 * `''` means "the current HEAD" (detached HEAD, listed as its own option).
 */
export function defaultBaseBranch(info: RepoInfo): string {
  if (info.defaultBranch && info.branches.includes(info.defaultBranch)) return info.defaultBranch
  if (info.unborn) return info.branches[0] ?? ''
  return info.currentBranch ?? ''
}

/**
 * A friendly, editable default branch name like `swift-otter-78dj6e`; shared with
 * the terminal's `--worktree` so both clients name worktrees the same way.
 */
export { suggestBranch }

/**
 * Why the given new-branch name can't be used, or null if it's fine. `branches`
 * is the repo's existing local branches (a new worktree needs a fresh name).
 */
export function branchNameError(name: string, branches: string[]): string | null {
  const trimmed = name.trim()
  if (!trimmed) return 'Enter a branch name.'
  if (!isSafeGitRef(trimmed)) return 'Use letters, numbers, and . _ / - (no leading dash).'
  if (branches.includes(trimmed)) return `Branch “${trimmed}” already exists.`
  return null
}
