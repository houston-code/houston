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

/** Result of initializing a git repo in a workspace (main → renderer via IPC). */
export interface GitInitResult {
  /** True when the workspace is a git repo after the call (freshly init'd or already one). */
  ok: boolean
  /** True when the workspace was already a repo, so nothing was created. */
  alreadyRepo?: boolean
  /** A short human-readable reason when `ok` is false. */
  error?: string
}
