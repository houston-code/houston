import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConversationWorktree, RepoInfo, WorktreeRemoval } from '@shared/agent'
import { isSafeGitRef } from '@shared/git'
import { parseWorktreePorcelain } from './git'

/**
 * Create and tear down git worktrees that back a conversation, so a chat can work
 * on its own branch in an isolated checkout. Worktrees live at
 * `<repoRoot>/.houston/worktrees/<slug>` — co-located with the repo so they're
 * easy to find — and a per-repo `.git/info/exclude` entry keeps them out of the
 * parent repo's `git status` without touching the tracked `.gitignore`.
 *
 * All git here uses `execFile` (no shell), and every ref/branch is validated with
 * {@link isSafeGitRef} before it reaches the command line, so a crafted branch
 * name can't be read as an option or inject a second command.
 */

/** Where worktrees are nested inside the repo (relative to the main worktree root). */
const WORKTREES_SUBDIR = join('.houston', 'worktrees')

/** The line we add to `.git/info/exclude` so nested worktrees don't show as untracked. */
const EXCLUDE_LINE = '/.houston/worktrees/'

/** Result of a git invocation: stdout plus stderr (for surfacing failures). */
export type GitRun = (args: string[], cwd: string) => Promise<string>

/** Default runner: rejects with an Error whose message carries git's stderr. */
function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, timeout: 15_000, maxBuffer: 4_000_000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || err.message || '').trim()
          reject(new Error(detail || `git ${args[0]} failed`))
        } else {
          resolve(stdout)
        }
      }
    )
  })
}

const EMPTY_REPO: RepoInfo = {
  isRepo: false,
  root: '',
  currentBranch: null,
  branches: [],
  exists: false
}

/**
 * Turn a free-form branch name into a filesystem-safe slug for the worktree dir
 * (e.g. `feature/Foo Bar` → `feature-foo-bar`). Pure. Always non-empty so a path
 * can be derived even from punctuation-only input.
 */
export function slugifyBranch(branch: string): string {
  const slug = branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'work'
}

/**
 * Compute the worktree directory for a slug under the repo root, appending a
 * numeric suffix until the path is free so two chats never collide. Pure aside
 * from the existence probe (injectable for tests).
 */
export function worktreePath(
  repoRoot: string,
  slug: string,
  exists: (p: string) => boolean = existsSync
): string {
  const base = join(repoRoot, WORKTREES_SUBDIR, slug)
  if (!exists(base)) return base
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`
    if (!exists(candidate)) return candidate
  }
}

/**
 * Read repo info for the new-chat worktree picker: the main worktree root, the
 * current branch, and the local branch list. Read-only git; never throws (a
 * non-repo just yields {@link EMPTY_REPO}). A path that no longer exists on disk
 * short-circuits to `exists: false` so callers can drop a stale default workspace
 * (e.g. a deleted worktree) rather than treat it like a plain non-repo folder.
 * `exec` and the existence probe are injectable for tests.
 */
export async function getRepoInfo(
  workspace: string,
  exec: GitRun = runGit,
  exists: (p: string) => boolean = existsSync
): Promise<RepoInfo> {
  // A missing directory isn't a non-repo folder — it's gone. Report that distinctly
  // (and skip the git spawn, which would only fail with ENOENT on the cwd anyway).
  if (!exists(workspace)) return { ...EMPTY_REPO, exists: false }
  let root: string
  try {
    // First worktree entry is always the main worktree — the right base for nesting.
    const out = await exec(['worktree', 'list', '--porcelain'], workspace)
    const main = parseWorktreePorcelain(out)[0]
    if (!main) return { ...EMPTY_REPO, exists: true }
    root = main.path
  } catch {
    // The path exists but isn't inside a git repo — a valid plain workspace.
    return { ...EMPTY_REPO, exists: true }
  }
  let currentBranch: string | null = null
  try {
    const b = (await exec(['rev-parse', '--abbrev-ref', 'HEAD'], workspace)).trim()
    currentBranch = b && b !== 'HEAD' ? b : null
  } catch {
    // detached or unborn HEAD — leave null
  }
  let branches: string[] = []
  try {
    const out = await exec(
      ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads/'],
      workspace
    )
    branches = out.split('\n').map((l) => l.trim()).filter(Boolean)
  } catch {
    // best-effort — an empty list just means no base suggestions
  }
  return { isRepo: true, root, currentBranch, branches, exists: true }
}

/** Append the worktrees-ignore line to `<repoRoot>/.git/info/exclude` if absent. Best-effort. */
function ensureExcluded(repoRoot: string, exec: GitRun): Promise<void> {
  return exec(['rev-parse', '--git-common-dir'], repoRoot)
    .then((out) => {
      const commonDir = out.trim()
      const dir = commonDir.startsWith('/') ? commonDir : join(repoRoot, commonDir)
      const infoDir = join(dir, 'info')
      const excludePath = join(infoDir, 'exclude')
      let current = ''
      try {
        current = readFileSync(excludePath, 'utf8')
      } catch {
        // no exclude file yet — we'll create it
      }
      if (current.split('\n').some((l) => l.trim() === EXCLUDE_LINE)) return
      mkdirSync(infoDir, { recursive: true })
      appendFileSync(excludePath, `${current.endsWith('\n') || !current ? '' : '\n'}${EXCLUDE_LINE}\n`)
    })
    .catch(() => {
      // exclude is a hygiene nicety, not load-bearing — never fail creation over it
    })
}

export interface CreateWorktreeInput {
  /** Any path inside the target repo (the chat's current workspace). */
  workspace: string
  /** New branch name to create and check out. Validated before use. */
  branch: string
  /** Optional base ref to branch from (defaults to the repo's current HEAD). */
  base?: string
}

/**
 * Create a new branch + worktree for a conversation. Validates the branch (and
 * base) as safe git refs, nests the worktree under the repo's main worktree, and
 * registers a `.git/info/exclude` entry so it stays out of `git status`. Returns
 * the metadata to persist on the conversation. Throws (surfaced to the renderer)
 * on a bad ref, a non-repo workspace, or a git failure (e.g. branch exists).
 */
export async function createWorktree(
  input: CreateWorktreeInput,
  exec: GitRun = runGit
): Promise<ConversationWorktree> {
  const branch = input.branch.trim()
  if (!isSafeGitRef(branch)) {
    throw new Error(`Invalid branch name: "${input.branch}"`)
  }
  if (input.base !== undefined && !isSafeGitRef(input.base)) {
    throw new Error(`Invalid base ref: "${input.base}"`)
  }
  const repo = await getRepoInfo(input.workspace, exec)
  if (!repo.isRepo) {
    throw new Error('This folder is not inside a git repository.')
  }
  const path = worktreePath(repo.root, slugifyBranch(branch))
  mkdirSync(join(repo.root, WORKTREES_SUBDIR), { recursive: true })
  await ensureExcluded(repo.root, exec)
  const args = ['worktree', 'add', '-b', branch, path]
  if (input.base) args.push(input.base)
  // `--` is implied for `worktree add`; refs are validated above. Run from the
  // repo root so a relative base resolves against the right repo.
  await exec(args, repo.root)
  return { path, branch, repoRoot: repo.root }
}

/**
 * Tear down a conversation's worktree. Without `force`, this is safe: the worktree
 * is only removed when it has no uncommitted changes, and the branch only when
 * it's fully merged — so work is never silently destroyed. With `force`, both are
 * removed unconditionally. Best-effort and never throws; reports what it did.
 */
export async function removeWorktree(
  wt: ConversationWorktree,
  opts: { force?: boolean } = {},
  exec: GitRun = runGit
): Promise<WorktreeRemoval> {
  const force = opts.force === true
  try {
    const args = ['worktree', 'remove', wt.path]
    if (force) args.push('--force')
    await exec(args, wt.repoRoot)
  } catch (e) {
    // `git worktree remove` refuses a dirty worktree without --force; keep the work.
    return {
      removed: false,
      branchDeleted: false,
      message:
        (e as Error).message ||
        `Worktree at ${wt.path} has uncommitted changes; left it in place.`
    }
  }
  let branchDeleted = false
  try {
    await exec(['branch', force ? '-D' : '-d', wt.branch], wt.repoRoot)
    branchDeleted = true
  } catch {
    // `-d` refuses an unmerged branch — leave it so commits aren't lost.
  }
  return {
    removed: true,
    branchDeleted,
    message: branchDeleted
      ? undefined
      : `Removed the worktree but kept branch "${wt.branch}" (it has unmerged commits).`
  }
}
