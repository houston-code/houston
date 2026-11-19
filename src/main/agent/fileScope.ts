import { lstatSync } from 'node:fs'
import { Minimatch, type MinimatchOptions } from 'minimatch'
import { hardenedGitArgs, runGitCapture, type GitCapture } from './gitRead'
import { isSensitivePath } from './sensitive-paths'

/**
 * Which files the agent's discovery tools (search_files, glob, ast_grep, the
 * composer's @-mentions, nested rules discovery) look at.
 *
 * Inside a git work tree the project's own ignore rules decide: every tracked file
 * is in scope (even one under a directory named `build/` or `vendor/`, or one that
 * matches a .gitignore pattern after being force-added), untracked files are in
 * scope unless .gitignore, .git/info/exclude, or the global excludes file ignores
 * them. Outside a repo there are no such rules, so a fixed set of well-known
 * dependency and build-output directory names is skipped instead.
 *
 * A search root that git itself ignores (e.g. the agent pointing straight at
 * `node_modules/some-pkg`) is treated as outside the repo: asking for it by path
 * is an explicit request to look there.
 */

/** Directory names skipped at any depth, but ONLY in folders git does not cover. */
export const FALLBACK_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  '.next',
  'vendor',
  '.venv',
  'venv',
  'target',
  '__pycache__',
  'coverage',
  '.gradle',
  '.tox',
  '.mypy_cache',
  'Pods',
  'DerivedData',
  '.terraform'
])

/**
 * Whether `dir` sits inside a git work tree and is not itself ignored. One git
 * call: check-ignore exits 0 (ignored), 1 (not ignored), or 128 (not a repo).
 */
export async function inGitScope(dir: string, hardening?: Promise<string[]>): Promise<boolean> {
  // 0 = ignored (an explicit request to look inside it); 128 = not a repo.
  return (await checkScope(dir, hardening)).code === 1
}

/** The check behind {@link inGitScope}, with git's exit status (null: no answer). */
function checkScope(dir: string, hardening?: Promise<string[]>): Promise<GitCapture> {
  return runGitCapture(['check-ignore', '-q', '--', dir], dir, hardening)
}

/**
 * Start working out `dir`'s git hardening once, for the few commands an operation
 * runs together (see runGitCapture). Each git command used to start its own probe.
 */
function shareHardening(dir: string): Promise<string[]> {
  const h = hardenedGitArgs(dir)
  // Every caller awaits it; this only keeps an early rejection from being reported as
  // unhandled before the first of them does.
  h.catch(() => {})
  return h
}

/** Split a NUL-terminated `git ls-files -z` listing. Paths use '/' on every OS. */
function splitZ(out: string): string[] {
  return out.split('\0').filter(Boolean)
}

/**
 * Every tracked file plus every untracked file the ignore rules allow, relative
 * to `dir` ('/'-separated), or null when `dir` is not in git scope (see
 * {@link inGitScope}). `pathspec` narrows the listing. Tracked files deleted from
 * disk are listed too; callers that read or stat each path already tolerate that.
 */
export async function gitListFiles(dir: string, pathspec: string[] = []): Promise<string[] | null> {
  const h = shareHardening(dir)
  if (!(await inGitScope(dir, h))) return null
  return listFilesInScope(dir, pathspec, h)
}

/** {@link gitListFiles} for a `dir` already known to be in git scope. */
async function listFilesInScope(dir: string, pathspec: string[], h: Promise<string[]>): Promise<string[] | null> {
  const res = await runGitCapture(
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...pathspec],
    dir,
    h
  )
  if (!res.ok) return null
  // A file both tracked and modified can be listed once per stage in a conflict;
  // dedupe so callers never search one file twice.
  return [...new Set(splitZ(res.stdout))]
}

/**
 * Tracked files that the ignore rules would exclude (force-added or committed
 * before the pattern existed), relative to `dir`. Ripgrep and ast-grep honor the
 * ignore files but know nothing of the index, so these are handed to them as
 * explicit paths to keep "never skip a tracked file" true on every backend.
 */
export async function gitTrackedIgnored(dir: string, hardening?: Promise<string[]>): Promise<string[]> {
  return trackedIgnoredOf(await runGitCapture(TRACKED_IGNORED_ARGS, dir, hardening))
}

const TRACKED_IGNORED_ARGS = ['ls-files', '--cached', '--ignored', '--exclude-standard', '-z']

/** {@link gitTrackedIgnored}'s answer, from its git run. */
function trackedIgnoredOf(res: GitCapture): string[] {
  return res.ok ? [...new Set(splitZ(res.stdout))] : []
}

/** Pathspecs for every path with a dot-named segment: a hidden file, or anything under a hidden directory. */
const HIDDEN_PATHSPECS = [':(glob)**/.*', ':(glob)**/.*/**']

/**
 * Whether a tracked hidden path is searched. Anything under a `.git` directory never
 * is, and neither is a credential file (see isSensitivePath): those were out of
 * reach while every hidden path was skipped, and a search that quotes their lines
 * would sidestep the prompt read_file gives them.
 */
export function searchableTrackedHidden(rel: string): boolean {
  return !rel.split('/').includes('.git') && !isSensitivePath(rel)
}

/**
 * Tracked files with a dot-named segment (`.github/workflows/ci.yml`, `.husky/pre-commit`),
 * relative to `dir`, minus the ones {@link searchableTrackedHidden} keeps out. The
 * discovery tools skip hidden paths, but a tracked one is project content like any
 * other, so these are searched too. Untracked hidden files stay skipped.
 */
export async function gitTrackedHidden(dir: string, hardening?: Promise<string[]>): Promise<string[]> {
  return trackedHiddenOf(await runGitCapture(TRACKED_HIDDEN_ARGS, dir, hardening))
}

const TRACKED_HIDDEN_ARGS = ['ls-files', '--cached', '-z', '--', ...HIDDEN_PATHSPECS]

/** {@link gitTrackedHidden}'s answer, from its git run. */
function trackedHiddenOf(res: GitCapture): string[] {
  if (!res.ok) return []
  return [...new Set(splitZ(res.stdout))].filter((rel) => hasHiddenSegment(rel) && searchableTrackedHidden(rel))
}

/**
 * Whether a '/'-separated relative path has a dot-named segment. Search and glob
 * skip hidden files and directories (as ripgrep does without --hidden) unless git
 * tracks them (see {@link gitTrackedHidden}); `keep` names basenames exempted from that.
 */
export function hasHiddenSegment(rel: string, keep: ReadonlySet<string> = new Set()): boolean {
  const parts = rel.split('/')
  return parts.some((p, i) => p.startsWith('.') && !(i === parts.length - 1 && keep.has(p)))
}

/**
 * How a backend that honors ignore files on its own (ripgrep, ast-grep) covers a
 * search root `dir`:
 *
 *  - `plain`: not in git scope; the backend skips FALLBACK_SKIP_DIRS itself.
 *  - `git` with `walk`: walk `dir` honoring git's ignore files, then search
 *    `explicit` too (tracked files those rules match, which the backends would
 *    otherwise skip: they read the ignore files but not the index).
 *  - `git` without `walk`: `dir` lies under an ignore pattern but holds tracked
 *    files (e.g. a committed `build/`). Walking from inside an ignored directory
 *    would not apply the parent's rule, so search exactly git's listing instead.
 *
 * `explicit` paths are relative to `dir`, '/'-separated, and include tracked hidden
 * files (the walk skips hidden paths; see {@link gitTrackedHidden}) but no untracked ones.
 */
export type ScopePlan = { kind: 'plain' } | { kind: 'git'; walk: boolean; explicit: string[] }

export async function planScope(dir: string): Promise<ScopePlan> {
  return (await planScopeFresh(dir)).value
}

/**
 * A planner's answer, and whether it may be reused: false when a git call it rests on
 * gave no answer (it timed out, git is missing, or the repository defines a filter
 * driver Houston won't run git under), so the next caller asks again.
 */
interface Planned<T> {
  value: T
  reusable: boolean
}

async function planScopeFresh(dir: string): Promise<Planned<ScopePlan>> {
  // One hardening probe for the whole plan. Both checks and both listings then start
  // at once: the listings don't depend on the checks (outside a repo they fail as fast
  // as the checks do, and their answer is dropped). Only a root under an ignore
  // pattern needs a second round, for its full listing, and that root is rare.
  const h = shareHardening(dir)
  const [scope, ignoredByPattern, ignored, hidden] = await Promise.all([
    checkScope(dir, h),
    // --no-index: does a pattern match `dir` (or an ancestor), tracked files aside?
    runGitCapture(['check-ignore', '--no-index', '-q', '--', dir], dir, h),
    runGitCapture(TRACKED_IGNORED_ARGS, dir, h),
    runGitCapture(TRACKED_HIDDEN_ARGS, dir, h)
  ])
  if (scope.code !== 1) return { value: { kind: 'plain' }, reusable: scope.code !== null }
  const underPattern = ignoredByPattern.code === 0
  const listed = underPattern ? await listFilesInScope(dir, [], h) : ignored.ok ? trackedIgnoredOf(ignored) : null
  // The walk skips hidden paths, so tracked ones are handed over explicitly too.
  const explicit = new Set([...(listed ?? []).filter((rel) => !hasHiddenSegment(rel)), ...trackedHiddenOf(hidden)])
  return {
    value: { kind: 'git', walk: !underPattern, explicit: [...explicit] },
    reusable: ignoredByPattern.code !== null && listed !== null && hidden.ok
  }
}

/** What glob looks through under a root: {@link gitListFiles} and {@link gitTrackedHidden} together. */
export interface ScopeListing {
  /** Every file in scope, relative to the root; null when it is not in git scope (see inGitScope). */
  listed: string[] | null
  /** The tracked hidden files that are searched (see gitTrackedHidden); empty outside git scope. */
  trackedHidden: string[]
}

/**
 * {@link gitListFiles} and {@link gitTrackedHidden} for `dir` in two rounds of git
 * rather than five: after the hardening probe, the scope check and both listings run
 * at once, and the listings are dropped when `dir` turns out not to be in git scope
 * (git does not walk an ignored directory's contents, so that costs no more than the check).
 */
export async function listScope(dir: string): Promise<ScopeListing> {
  return (await listScopeFresh(dir)).value
}

async function listScopeFresh(dir: string): Promise<Planned<ScopeListing>> {
  const h = shareHardening(dir)
  const [scope, listed, hidden] = await Promise.all([
    checkScope(dir, h),
    listFilesInScope(dir, [], h),
    runGitCapture(TRACKED_HIDDEN_ARGS, dir, h)
  ])
  if (scope.code !== 1) return { value: { listed: null, trackedHidden: [] }, reusable: scope.code !== null }
  return { value: { listed, trackedHidden: trackedHiddenOf(hidden) }, reusable: listed !== null && hidden.ok }
}

/**
 * How long a {@link ScopeCache} entry is reused at most: the read cache's window for
 * a search result (TREE_READ_TTL_MS), for the same reason.
 */
export const SCOPE_CACHE_TTL_MS = 30_000

/** Search roots a {@link ScopeCache} holds at once; past it, the oldest is dropped. */
export const SCOPE_CACHE_MAX_ROOTS = 32

interface Memo<T> {
  /** When the planning started. */
  at: number
  value: Promise<T>
}

/**
 * One run's memo of the planning above, per search root: {@link planScope} for
 * search_files and ast_grep, {@link listScope} for glob and the JS search fallback.
 * Planning starts several git processes before a search can, whatever the pattern,
 * while what it reads (which files are tracked, ignored, hidden, or present) only
 * changes when something changes the index, an ignore file, or the tree. So it is
 * worked out once and reused until any of these:
 *
 *  - the run makes a call that may have changed that. The loop invalidates it on
 *    every call that isn't a read (any write, apply_patch, a shell command, a git or
 *    gh tool that writes, a writable subagent), where it invalidates the read cache;
 *  - the run hears from background work that may have written since: `wait_for`,
 *    `read_shell_output` or `kill_shell` returns, or a background shell, agent, or
 *    spawned session's news is delivered;
 *  - {@link SCOPE_CACHE_TTL_MS} passes, which bounds how long a change the run never
 *    saw (the user's own `git add`, a background command still running) goes unnoticed;
 *  - the run ends. The loop makes one per run, and shares it with nothing else.
 *
 * Only an answer every git call behind it gave is kept (see {@link Planned}), and
 * callers asking for one root while it is being planned share that planning. A hit
 * is exactly what planning returned, so callers still check each listed path on disk
 * when they use it, and must not change the arrays they are handed.
 */
export class ScopeCache {
  private readonly plans = new Map<string, Memo<ScopePlan>>()
  private readonly listings = new Map<string, Memo<ScopeListing>>()
  private readonly now: () => number
  private readonly ttlMs: number

  constructor(opts: { now?: () => number; ttlMs?: number } = {}) {
    this.now = opts.now ?? Date.now
    this.ttlMs = opts.ttlMs ?? SCOPE_CACHE_TTL_MS
  }

  /** {@link planScope} for `dir`, from memory when this run has planned it already. */
  plan(dir: string): Promise<ScopePlan> {
    return this.memo(this.plans, dir, planScopeFresh)
  }

  /** {@link listScope} for `dir`, from memory when this run has listed it already. */
  listing(dir: string): Promise<ScopeListing> {
    return this.memo(this.listings, dir, listScopeFresh)
  }

  /** Forget everything, so the next search plans afresh. */
  invalidate(): void {
    this.plans.clear()
    this.listings.clear()
  }

  /** Entries held, for tests. */
  get size(): number {
    return this.plans.size + this.listings.size
  }

  private memo<T>(entries: Map<string, Memo<T>>, dir: string, fresh: (dir: string) => Promise<Planned<T>>): Promise<T> {
    const now = this.now()
    const held = entries.get(dir)
    if (held && now - held.at < this.ttlMs) return held.value
    entries.delete(dir)
    // An answer that can't be reused is dropped once it arrives, unless an
    // invalidation (or a newer entry) has already replaced it.
    const forget = (): void => {
      if (entries.get(dir) === memo) entries.delete(dir)
    }
    const memo: Memo<T> = {
      at: now,
      value: fresh(dir).then(
        (r) => {
          if (!r.reusable) forget()
          return r.value
        },
        (e: unknown) => {
          forget()
          throw e
        }
      )
    }
    entries.set(dir, memo)
    if (entries.size > SCOPE_CACHE_MAX_ROOTS) {
      const oldest = entries.keys().next().value
      if (oldest !== undefined) entries.delete(oldest)
    }
    return memo.value
  }
}

/**
 * Characters of explicit paths one run may carry. Windows caps a whole command line at
 * 32,767 characters (program, flags, pattern, and every path, each quoted when it has a
 * space), so a batch of long paths failed the search outright; this leaves room for the
 * rest. POSIX limits are far higher.
 */
export const MAX_RUN_PATH_CHARS = 24_000

/**
 * Plan the runs of a search backend that honors ignore files: one that walks the
 * search root (unless `walk` is false), then `extraPaths` in batches small enough
 * to stay well under every platform's argv limit: at most `perRun` paths, and at most
 * `maxChars` characters of them (a single longer path still gets a run of its own).
 */
export function planRuns(
  searchRel: string,
  extraPaths: string[],
  perRun = 500,
  walk = true,
  maxChars = MAX_RUN_PATH_CHARS
): { searchRel: string; extraPaths: string[] }[] {
  const runs = walk ? [{ searchRel, extraPaths: [] as string[] }] : []
  let batch: string[] = []
  let chars = 0
  for (const p of extraPaths) {
    // The separating space, and the quotes Windows adds around a path with a space.
    const cost = p.length + 1 + (/\s/.test(p) ? 2 : 0)
    if (batch.length > 0 && (batch.length >= perRun || chars + cost > maxChars)) {
      runs.push({ searchRel: '', extraPaths: batch })
      batch = []
      chars = 0
    }
    batch.push(p)
    chars += cost
  }
  if (batch.length) runs.push({ searchRel: '', extraPaths: batch })
  return runs
}

/** Positional path arguments for one planned run (an empty `searchRel` means none). */
export function runPathArgs(searchRel: string, extraPaths: string[] = []): string[] {
  if (searchRel === '' && extraPaths.length) return extraPaths
  return [searchRel || '.', ...extraPaths]
}

/**
 * Whether `full` is a regular file: not a symlink (git tracks those, and following
 * one could read outside the workspace; the directory walks never followed them
 * either), not a submodule or nested repo, and not a tracked file deleted from disk.
 */
export function isRegularFile(full: string): boolean {
  try {
    return lstatSync(full).isFile()
  } catch {
    return false
  }
}

/**
 * A path tester for `pattern`, equivalent to `minimatch(rel, pattern, options)` on
 * every call. The pattern is compiled once, on the first test (so an invalid
 * pattern throws exactly when the per-call form would), and reused for every path
 * after that: minimatch() rebuilds a cache key from the pattern and options on each
 * call, which dominated a glob over a large repo's listing.
 */
export function globTester(pattern: string, options: MinimatchOptions = {}): (rel: string) => boolean {
  let mm: Minimatch | undefined
  return (rel) => {
    // minimatch() short-circuits a comment pattern; Minimatch.match does the same.
    mm ??= new Minimatch(pattern, options)
    return mm.match(rel)
  }
}
