import { isSafeGitRef } from '@shared/git'
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
 * (toggle off), and a path that vanished from disk is dropped. Pure.
 */
export function planNewChatWorkspace(info: RepoInfo, workspace: string): NewChatWorkspacePlan {
  if (!info.exists) return { action: 'drop' }
  const norm = (p: string): string => p.replace(/\/+$/, '')
  if (info.isRepo && info.root && info.isLinkedWorktreeRoot && norm(info.root) !== norm(workspace)) {
    return { action: 'reanchor', root: info.root }
  }
  const isSubdir = info.isRepo && !!info.root && norm(info.root) !== norm(workspace)
  return { action: 'keep', worktreeDefault: info.isRepo && !isSubdir }
}

const ADJECTIVES = ['swift', 'bright', 'calm', 'bold', 'keen', 'brave', 'lucid', 'eager']
const NOUNS = ['otter', 'falcon', 'maple', 'comet', 'harbor', 'cedar', 'quartz', 'meadow']
const SUFFIX_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'

/**
 * A friendly, editable default branch name like `swift-otter-78dj6e`. The
 * 6-char random suffix keeps suggestions unique so two new chats don't collide
 * on the same branch/worktree.
 */
export function suggestBranch(): string {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]
  const n = NOUNS[Math.floor(Math.random() * NOUNS.length)]
  const suffix = Array.from(
    { length: 6 },
    () => SUFFIX_CHARS[Math.floor(Math.random() * SUFFIX_CHARS.length)]
  ).join('')
  return `${a}-${n}-${suffix}`
}

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
