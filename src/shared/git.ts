/**
 * Git helpers shared by the main process (where refs reach the command line) and
 * the renderer (instant validation feedback in the new-worktree dialog).
 */

/**
 * Whether a ref is safe to pass to git as a positional revision/branch. Refs are
 * run via execFile (no shell), so the only injection risk is a value that begins
 * with `-` being read as an *option* (e.g. `--output=<file>`, which would write a
 * file). Requiring a leading ref character and a conservative charset closes that.
 */
export function isSafeGitRef(ref: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/~^@{}-]*$/.test(ref)
}

const ADJECTIVES = ['swift', 'bright', 'calm', 'bold', 'keen', 'brave', 'lucid', 'eager']
const NOUNS = ['otter', 'falcon', 'maple', 'comet', 'harbor', 'cedar', 'quartz', 'meadow']
const SUFFIX_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'

/**
 * A friendly, editable default branch name like `swift-otter-78dj6e`. The
 * 6-char random suffix keeps suggestions unique so two new chats (or terminal
 * sessions started with `--worktree`) don't collide on the same branch/worktree.
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

/** Result of initializing a git repo in a workspace (main → renderer via IPC). */
export interface GitInitResult {
  /** True when the workspace is a git repo after the call (freshly init'd or already one). */
  ok: boolean
  /** True when the workspace was already a repo, so nothing was created. */
  alreadyRepo?: boolean
  /** A short human-readable reason when `ok` is false. */
  error?: string
}
