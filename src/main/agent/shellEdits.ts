/**
 * Which files a shell command changed.
 *
 * File tools report the paths they write, so the turn's ledger (the receipt, the verify
 * gate, "passed before the last change") sees every edit they make. A shell command
 * reports nothing: `sed -i`, `git apply`, a heredoc, or a code generator changes files
 * the ledger never hears of. Around a foreground run_shell call that may write, the loop
 * takes a cheap snapshot of the git working tree before and after (the `git status`
 * listing plus the size and modification time of each listed path) and records the
 * paths that differ, plus the files that differ between the commits HEAD named before
 * and after, when the command moved it.
 *
 * Bounded and inert: every git call goes through the hardened runner (no hooks, no
 * filters, no fsmonitor, no optional index lock), a tree with too many dirty paths is
 * not snapshotted, and outside a git work tree there is no snapshot at all. Never throws.
 */
import { lstatSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { GIT_HARDENING, hardenedGitArgs, runGitCapture } from './gitRead'

/** Dirty paths above this and the tree isn't snapshotted: too costly to stat each time. */
export const MAX_SNAPSHOT_PATHS = 2_000

/** The working tree's uncommitted state at one moment. */
export interface TreeSnapshot {
  /** The repository's top level, as a real path. */
  top: string
  /** The workspace, as a real path: changed paths are reported relative to it. */
  base: string
  /** What git's search for the repository from `base` sees (see {@link discoveryMarks}). */
  marks: string
  /** Each listed path's size and mtime, or 'missing' for one that isn't on disk. */
  entries: Map<string, string>
  /**
   * The commit checked out, or null when there is none yet. A command that changes
   * files and commits them, or moves HEAD (`git pull`, `git switch`, `git reset`), leaves
   * a tree that is clean before and after; only HEAD shows what it changed.
   */
  head?: string | null
}

/** The commit HEAD names in `top`, or null (an unborn branch, or git failed). */
async function headOf(top: string, hardening: Promise<string[]>): Promise<string | null> {
  const r = await runGitCapture(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], top, hardening)
  const sha = r.ok ? r.stdout.trim() : ''
  return /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha) ? sha : null
}

/**
 * The paths that differ between two commits, relative to the repository top. Compares
 * trees only (no file contents are read, so no filter runs). At most
 * {@link MAX_SNAPSHOT_PATHS}; empty when git fails.
 */
async function pathsBetween(from: string, to: string, top: string, hardening: Promise<string[]>): Promise<string[]> {
  const r = await runGitCapture(['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', from, to, '--'], top, hardening)
  if (!r.ok) return []
  return r.stdout.split('\0').filter(Boolean).slice(0, MAX_SNAPSHOT_PATHS)
}

function statOf(path: string): string {
  try {
    const st = statSync(path)
    return `${st.size}:${st.mtimeMs}`
  } catch {
    return 'missing'
  }
}

/**
 * The `.git` entry (or its absence) in each directory git's repository search passes
 * through from `base` up to `top`. While these are unchanged git finds the same top level
 * from `base`, so {@link changedSince} need not ask for it again; a `.git` removed,
 * replaced, or newly created in between (`rm -rf .git`, `git init` in a subfolder) changes
 * them.
 */
function discoveryMarks(base: string, top: string): string {
  const marks: string[] = []
  for (let dir = base; ; dir = dirname(dir)) {
    let mark = '-'
    try {
      const st = lstatSync(join(dir, '.git'))
      mark = `${st.dev}:${st.ino}${st.isDirectory() ? '' : `:${st.size}:${st.mtimeMs}`}`
    } catch {
      // No `.git` here.
    }
    marks.push(mark)
    if (dir === top || dirname(dir) === dir) break
  }
  return marks.join('|')
}

/**
 * `git status`'s listing of the working tree at `top`, each path with its size and
 * mtime. Null when git fails or more than {@link MAX_SNAPSHOT_PATHS} paths are dirty.
 */
async function listTree(top: string, hardening: Promise<string[]>): Promise<Map<string, string> | null> {
  const status = await runGitCapture(
    ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'],
    top,
    hardening
  )
  if (!status.ok) return null
  const entries = new Map<string, string>()
  for (const record of status.stdout.split('\0')) {
    if (record.length < 4) continue
    if (entries.size >= MAX_SNAPSHOT_PATHS) return null
    const rel = record.slice(3)
    entries.set(rel, statOf(join(top, rel)))
  }
  return entries
}

/**
 * The workspace's git working tree as `git status` lists it, with each listed path's
 * size and mtime. Null outside a git work tree, when git fails, or when more than
 * {@link MAX_SNAPSHOT_PATHS} paths are dirty.
 */
export async function snapshotWorkingTree(workspace: string): Promise<TreeSnapshot | null> {
  let base: string
  try {
    base = realpathSync(workspace)
  } catch {
    return null
  }
  // The filter-driver probe and `rev-parse` run together: `rev-parse` reads no file
  // contents, so no filter can run and the fixed flags harden it fully. The probe still
  // decides: a repo git won't run in is "no snapshot", like a plain folder.
  const hardening = hardenedGitArgs(base)
  const [probed, topOut] = await Promise.all([
    hardening.then(
      () => true,
      () => false
    ),
    runGitCapture(['rev-parse', '--show-toplevel'], base, Promise.resolve(GIT_HARDENING))
  ])
  if (!probed || !topOut.ok || !topOut.stdout.trim()) return null
  let top: string
  try {
    top = realpathSync(topOut.stdout.trim())
  } catch {
    return null
  }
  const [entries, head] = await Promise.all([listTree(top, hardening), headOf(top, hardening)])
  return entries && { top, base, marks: discoveryMarks(base, top), entries, head }
}

/**
 * The paths that changed between `before` and the tree now, relative to the workspace:
 * a path newly listed, one whose status or size/mtime moved, and one no longer listed
 * whose file changed (`git checkout -- f`, `rm f`). A dirty file that was only staged or
 * committed, unchanged on disk, is not a change. Paths outside the workspace are left
 * out. Empty when the tree can't be read again, or when the workspace or the repository
 * git finds from it is no longer the one `before` read.
 *
 * Reuses `before`'s top level rather than asking git again, but probes the filter drivers
 * afresh: the command just run may have planted one in the repository's config.
 */
export async function changedSince(before: TreeSnapshot, workspace: string): Promise<string[]> {
  let base: string
  try {
    base = realpathSync(workspace)
  } catch {
    return []
  }
  if (base !== before.base || discoveryMarks(base, before.top) !== before.marks) return []
  const hardening = hardenedGitArgs(before.top)
  const [after, head] = await Promise.all([listTree(before.top, hardening), headOf(before.top, hardening)])
  if (!after) return []
  const changed = new Set<string>()
  // HEAD moved (a commit, a pull, a branch switch, a reset): the files that differ
  // between the two commits changed too, even where the tree is clean both times.
  // A file that was dirty before and is the same on disk now was only committed (or
  // stashed into the commit), not changed.
  if (before.head && head && head !== before.head) {
    for (const rel of await pathsBetween(before.head, head, before.top, hardening)) {
      const was = before.entries.get(rel)
      if (was === undefined || statOf(join(before.top, rel)) !== was) changed.add(rel)
    }
  }
  for (const [rel, now] of after) {
    const was = before.entries.get(rel)
    // Staging alone (` M` to `M `) changes the status code, not the file.
    if (was !== now) changed.add(rel)
  }
  for (const [rel, was] of before.entries) {
    if (after.has(rel)) continue
    if (statOf(join(before.top, rel)) !== was) changed.add(rel)
  }
  const out: string[] = []
  for (const rel of changed) {
    const fromBase = relative(before.base, join(before.top, rel))
    if (!fromBase || fromBase.startsWith('..') || isAbsolute(fromBase)) continue
    out.push(fromBase)
  }
  return out.sort()
}

/** Programs that only read (with the write options checked below). */
const READ_ONLY = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'pwd', 'echo', 'printf',
  'which', 'type', 'file', 'stat', 'du', 'df', 'tree', 'less', 'more', 'diff', 'cmp', 'basename',
  'dirname', 'realpath', 'readlink', 'true', 'false', 'date', 'printenv', 'uname', 'whoami', 'id',
  'hostname', 'uniq', 'cut', 'tr', 'nl', 'column', 'jq', 'test', '[', 'cd', 'pushd', 'popd', 'sleep',
  'ps', 'lsof', 'man', 'sed', 'find', 'sort'
])
/** git subcommands that leave the working tree alone. */
const GIT_READ_ONLY = new Set([
  'status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'blame', 'grep', 'describe',
  'shortlog', 'cat-file', 'reflog', 'remote', 'config', 'branch', 'tag', 'rev-list', 'merge-base',
  'name-rev', 'whatchanged', 'version', 'help'
])
/** Options that make an otherwise read-only program write. */
const WRITE_OPTION: Record<string, RegExp> = {
  sed: /(^|\s)(-[a-zA-Z]*i|--in-place)/,
  find: /\s-(delete|exec|execdir|ok|okdir|fprint\w*|fls)\b/,
  sort: /(^|\s)(-[a-zA-Z]*o|--output)/
}

/**
 * Whether a shell command might change files, read loosely: false only when every part
 * of it runs a program from a short read-only list with no write option and nothing is
 * redirected to a file. Anything it can't read (a substitution, an unknown program) may
 * write. Only decides whether the tree is snapshotted, so a wrong "may" costs a `git
 * status`, never a missed fact the receipt relied on alone. Pure.
 */
export function shellMayEdit(command: string): boolean {
  if (/\$\(|`|<\(|>\(/.test(command)) return true
  // Redirections that write nothing: to /dev/null, or one stream onto another.
  const unredirected = command.replace(/(\d|&)?>>?\s*\/dev\/null|\d?>&\d|>&2/g, '')
  if (/>/.test(unredirected)) return true
  for (const part of unredirected.split(/&&|\|\||[;|&\n]/)) {
    const words = part.trim().replace(/^[({!\s]+/, '').split(/\s+/).filter(Boolean)
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift()
    if (!words.length) continue
    const program = words[0].replace(/^.*\//, '')
    if (program === 'git') {
      const sub = words.slice(1).find((w) => !w.startsWith('-'))
      if (!sub || !GIT_READ_ONLY.has(sub)) return true
      continue
    }
    if (!READ_ONLY.has(program)) return true
    const writes = WRITE_OPTION[program]
    if (writes && writes.test(` ${words.slice(1).join(' ')}`)) return true
  }
  return false
}
