import { execFile } from 'node:child_process'

/**
 * Lightweight git awareness: at the start of a run we read the workspace's
 * current branch and working-tree status and fold a short summary into the system
 * prompt, so the agent knows what branch it's on and what's already modified
 * without having to run git itself. Read-only git commands, so they don't go
 * through the sandbox; never throws (a non-repo just yields no context).
 */

/** Max porcelain lines to include verbatim. */
const MAX_STATUS_LINES = 20

export type GitExec = (args: string[], cwd: string) => Promise<string>

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, timeout: 5000, maxBuffer: 1_000_000, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    )
  })
}

/** Format the branch + porcelain status into a compact prompt section. Pure. */
export function formatGitContext(branch: string | null, statusPorcelain: string): string {
  if (!branch) return ''
  const lines = statusPorcelain.split('\n').filter((l) => l.trim().length > 0)
  const summary =
    lines.length === 0
      ? 'working tree clean'
      : `${lines.length} uncommitted change${lines.length === 1 ? '' : 's'}`
  let out = `Git: on branch "${branch}" — ${summary}.`
  if (lines.length > 0) {
    const shown = lines.slice(0, MAX_STATUS_LINES).join('\n')
    out += `\nChanged files (git status --porcelain):\n${shown}`
    if (lines.length > MAX_STATUS_LINES) out += `\n… and ${lines.length - MAX_STATUS_LINES} more`
  }
  return out
}

/** Read the workspace's git context, or '' if it isn't a git repo. `exec` is injectable for tests. */
export async function gitContext(workspace: string, exec: GitExec = runGit): Promise<string> {
  let branch: string
  try {
    branch = (await exec(['rev-parse', '--abbrev-ref', 'HEAD'], workspace)).trim()
  } catch {
    return '' // not a git repo (or git unavailable)
  }
  if (!branch) return ''
  let status = ''
  try {
    status = await exec(['status', '--porcelain'], workspace)
  } catch {
    // status failed (e.g. detached/edge state) — still report the branch.
  }
  return formatGitContext(branch, status)
}

/**
 * Whether a ref is safe to pass to git as a positional revision. Refs are run via
 * execFile (no shell), so the only injection risk is a value that begins with `-`
 * being read as an *option* (e.g. `--output=<file>`, which would write a file).
 * Requiring a leading ref character and a conservative charset closes that.
 */
export function isSafeGitRef(ref: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/~^@{}-]*$/.test(ref)
}

/** The uncommitted change set for a workspace, used as input to a review. */
export interface WorkspaceDiff {
  /** False when the workspace is not a git repo (there is no diff to review). */
  isRepo: boolean
  /** Unified diff of tracked changes vs `base` (staged + unstaged); '' if none. */
  diff: string
  /** Paths of new, untracked, non-ignored files (not present in `diff`). */
  untracked: string[]
}

/**
 * Read the workspace's uncommitted changes for review: the diff of tracked files
 * against `base` (default HEAD, i.e. everything not yet committed) plus the list
 * of new untracked files. Read-only git, never throws. `exec` is injectable.
 */
export async function gitDiff(
  workspace: string,
  base = 'HEAD',
  exec: GitExec = runGit
): Promise<WorkspaceDiff> {
  try {
    await exec(['rev-parse', '--is-inside-work-tree'], workspace)
  } catch {
    return { isRepo: false, diff: '', untracked: [] }
  }
  let diff = ''
  // Refuse an option-like base (defence in depth — callers should validate too).
  if (isSafeGitRef(base)) {
    try {
      // `--` guards against `base` being read as a path; on a repo with no commits
      // `git diff HEAD` throws (no HEAD) — the untracked list carries the review then.
      diff = await exec(['diff', base, '--'], workspace)
    } catch {
      // invalid base (e.g. unborn HEAD) — fall back to no tracked diff
    }
  }
  let untracked: string[] = []
  try {
    const out = await exec(['ls-files', '--others', '--exclude-standard'], workspace)
    untracked = out.split('\n').map((l) => l.trim()).filter(Boolean)
  } catch {
    // ignore — untracked listing is best-effort
  }
  return { isRepo: true, diff: diff.trim(), untracked }
}
