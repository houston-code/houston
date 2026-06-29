import { isSafeGitRef } from '@shared/git'

/**
 * Helpers for the inline "new chat in a worktree" controls in the control bar.
 * Branch-name validity mirrors the main process's authoritative check so the
 * composer's Send button can gate on it for instant feedback.
 */

const ADJECTIVES = ['swift', 'bright', 'calm', 'bold', 'keen', 'brave', 'lucid', 'eager']
const NOUNS = ['otter', 'falcon', 'maple', 'comet', 'harbor', 'cedar', 'quartz', 'meadow']

/** A friendly, editable default branch name like `swift-otter`. */
export function suggestBranch(): string {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]
  const n = NOUNS[Math.floor(Math.random() * NOUNS.length)]
  return `${a}-${n}`
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
