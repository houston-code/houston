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

/** Max linked worktrees to list verbatim (keeps the prompt section bounded). */
const MAX_WORKTREES = 10

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

/** One entry from `git worktree list --porcelain`. */
export interface WorktreeEntry {
  /** Absolute path of the worktree's working directory. */
  path: string
  /** Short branch name (e.g. "main"), or null when the worktree is detached/bare. */
  branch: string | null
  /** True for a detached-HEAD worktree (no branch checked out). */
  detached: boolean
  /** True for a bare repository entry. */
  bare: boolean
}

/**
 * Parse the output of `git worktree list --porcelain` into entries. Records are
 * separated by blank lines; each is a set of `key value` lines (`worktree <path>`,
 * `HEAD <sha>`, `branch refs/heads/<name>`, plus bare flags `detached`/`bare`).
 * The first entry is always the main worktree. Pure; tolerant of unknown keys.
 */
export function parseWorktreePorcelain(out: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  let cur: WorktreeEntry | null = null
  for (const raw of out.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.startsWith('worktree ')) {
      if (cur) entries.push(cur)
      cur = { path: line.slice('worktree '.length).trim(), branch: null, detached: false, bare: false }
    } else if (!cur) {
      continue
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '')
    } else if (line === 'detached') {
      cur.detached = true
    } else if (line === 'bare') {
      cur.bare = true
    }
  }
  if (cur) entries.push(cur)
  return entries
}

/**
 * Format the main-worktree path and linked-worktree list into a compact prompt
 * line, or '' when the repo has only a single worktree (nothing worth surfacing).
 * `workspace` is the current working directory, flagged in the list. Pure.
 */
export function formatWorktreeContext(entries: WorktreeEntry[], workspace: string): string {
  // The first entry is the main worktree; "linked" worktrees are the rest.
  const main = entries[0]
  if (!main || entries.length <= 1) return ''
  const norm = (p: string): string => p.replace(/\/+$/, '')
  const ws = norm(workspace)
  let out = `Git worktrees: this repo has ${entries.length} worktrees; main worktree is at "${main.path}".`
  const linked = entries.slice(1)
  const shown = linked.slice(0, MAX_WORKTREES).map((w) => {
    const ref = w.bare ? 'bare' : w.detached ? 'detached' : (w.branch ?? 'detached')
    const here = norm(w.path) === ws ? ' (current)' : ''
    return `  ${w.path} [${ref}]${here}`
  })
  out += `\nLinked worktrees:\n${shown.join('\n')}`
  if (linked.length > MAX_WORKTREES) out += `\n… and ${linked.length - MAX_WORKTREES} more`
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
  let worktrees = ''
  try {
    const out = await exec(['worktree', 'list', '--porcelain'], workspace)
    worktrees = formatWorktreeContext(parseWorktreePorcelain(out), workspace)
  } catch {
    // worktree listing is best-effort (old git, edge state) — omit it.
  }
  const base = formatGitContext(branch, status)
  return worktrees ? `${base}\n${worktrees}` : base
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
