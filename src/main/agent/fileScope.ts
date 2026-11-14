import { lstatSync } from 'node:fs'
import { Minimatch, type MinimatchOptions } from 'minimatch'
import { hardenedGitArgs, runGitCapture } from './gitRead'
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
  const res = await runGitCapture(['check-ignore', '-q', '--', dir], dir, hardening)
  // 0 = ignored (an explicit request to look inside it); 128 = not a repo.
  return res.code === 1
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
  const res = await runGitCapture(
    ['ls-files', '--cached', '--ignored', '--exclude-standard', '-z'],
    dir,
    hardening
  )
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
  const res = await runGitCapture(['ls-files', '--cached', '-z', '--', ...HIDDEN_PATHSPECS], dir, hardening)
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
  // One hardening probe for the whole plan, and the two independent checks at once.
  const h = shareHardening(dir)
  const [inScope, ignoredByPattern] = await Promise.all([
    inGitScope(dir, h),
    // --no-index: does a pattern match `dir` (or an ancestor), tracked files aside?
    runGitCapture(['check-ignore', '--no-index', '-q', '--', dir], dir, h)
  ])
  if (!inScope) return { kind: 'plain' }
  const underPattern = ignoredByPattern.code === 0
  const [listed, hidden] = await Promise.all([
    underPattern ? listFilesInScope(dir, [], h).then((l) => l ?? []) : gitTrackedIgnored(dir, h),
    gitTrackedHidden(dir, h)
  ])
  // The walk skips hidden paths, so tracked ones are handed over explicitly too.
  const explicit = new Set([...listed.filter((rel) => !hasHiddenSegment(rel)), ...hidden])
  return { kind: 'git', walk: !underPattern, explicit: [...explicit] }
}

/**
 * Plan the runs of a search backend that honors ignore files: one that walks the
 * search root (unless `walk` is false), then `extraPaths` in batches small enough
 * to stay well under every platform's argv limit.
 */
export function planRuns(
  searchRel: string,
  extraPaths: string[],
  perRun = 500,
  walk = true
): { searchRel: string; extraPaths: string[] }[] {
  const runs = walk ? [{ searchRel, extraPaths: [] as string[] }] : []
  for (let i = 0; i < extraPaths.length; i += perRun) {
    runs.push({ searchRel: '', extraPaths: extraPaths.slice(i, i + perRun) })
  }
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
