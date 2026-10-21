import { lstatSync } from 'node:fs'
import { runGitCapture } from './gitRead'

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
export async function inGitScope(dir: string): Promise<boolean> {
  const res = await runGitCapture(['check-ignore', '-q', '--', dir], dir)
  // 0 = ignored (an explicit request to look inside it); 128 = not a repo.
  return res.code === 1
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
  if (!(await inGitScope(dir))) return null
  const res = await runGitCapture(
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...pathspec],
    dir
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
export async function gitTrackedIgnored(dir: string): Promise<string[]> {
  const res = await runGitCapture(
    ['ls-files', '--cached', '--ignored', '--exclude-standard', '-z'],
    dir
  )
  return res.ok ? [...new Set(splitZ(res.stdout))] : []
}

/**
 * Whether a '/'-separated relative path has a dot-named segment. Search and glob
 * skip hidden files and directories (as ripgrep does without --hidden); `keep`
 * names basenames exempted from that.
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
 * `explicit` paths are relative to `dir`, '/'-separated, and exclude hidden ones.
 */
export type ScopePlan = { kind: 'plain' } | { kind: 'git'; walk: boolean; explicit: string[] }

export async function planScope(dir: string): Promise<ScopePlan> {
  if (!(await inGitScope(dir))) return { kind: 'plain' }
  // --no-index: does a pattern match `dir` (or an ancestor), tracked files aside?
  const underPattern = (await runGitCapture(['check-ignore', '--no-index', '-q', '--', dir], dir)).code === 0
  const explicit = underPattern ? ((await gitListFiles(dir)) ?? []) : await gitTrackedIgnored(dir)
  return { kind: 'git', walk: !underPattern, explicit: explicit.filter((rel) => !hasHiddenSegment(rel)) }
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
