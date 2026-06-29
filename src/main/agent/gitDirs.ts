import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * Resolving the extra writable roots a git workspace needs beyond its own working
 * tree.
 *
 * The sandbox confines writes to the workspace (+ added dirs) + temp. In a plain
 * checkout that's enough: `.git` is a DIRECTORY inside the workspace, so git's
 * writes already land in a writable root. But a linked worktree's `.git` is a FILE
 * pointing at a git dir OUTSIDE the workspace, so a bare `git fetch`/`commit`/
 * `checkout` fails on the sandbox write-denial (EPERM), not on anything real. We
 * widen the writable roots to cover the two git dirs such commands must touch.
 */

/** Whether `abs` is `root` itself or lives inside it (mirrors tools.ts). */
function isWithin(root: string, abs: string): boolean {
  const rel = relative(root, abs)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** Filesystem seams, injectable so the resolver is unit-testable without a real repo. */
export interface GitDirsIo {
  /** 'dir' | 'file' | 'other' for a path; 'other' when it's missing or unreadable. */
  kindOf: (p: string) => 'dir' | 'file' | 'other'
  readText: (p: string) => string
  /** Canonicalize a path; returns the input unchanged when it can't be resolved. */
  realpath: (p: string) => string
}

const defaultIo: GitDirsIo = {
  kindOf: (p) => {
    try {
      const st = lstatSync(p)
      return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other'
    } catch {
      return 'other'
    }
  },
  readText: (p) => readFileSync(p, 'utf8'),
  realpath: (p) => {
    try {
      return realpathSync(p)
    } catch {
      return p
    }
  }
}

/** Absolutize a git pointer path: absolute as-is, else resolved against `base`. */
function absolutize(p: string, base: string): string {
  const trimmed = p.trim()
  return isAbsolute(trimmed) ? trimmed : resolve(base, trimmed)
}

/**
 * Extra writable roots a git workspace needs beyond its own working tree, so a
 * sandboxed `git fetch`/`commit`/`checkout` doesn't hit a write-denial.
 *
 * Returns [] for a plain checkout — `.git` is a directory inside the workspace,
 * already within the writable root. For a linked worktree (and a submodule) `.git`
 * is a FILE pointing at a git dir that lives OUTSIDE the workspace:
 *   - the per-worktree dir `<common>/worktrees/<name>` holds what fetch/commit/
 *     checkout rewrite per worktree (FETCH_HEAD, ORIG_HEAD, HEAD, index, logs, refs);
 *   - the shared object store and refs live in the COMMON dir `<common>` (the main
 *     repo's `.git`), located via the `commondir` file in the git dir (usually `../..`).
 * Both must be writable or git fails under the sandbox. A plain submodule has a git
 * dir but no `commondir`, so only that one dir is returned.
 *
 * Yields realpath'd absolute dirs that fall OUTSIDE `workspace` (anything already
 * inside it is covered by the workspace root). Never throws; a non-repo or an
 * unreadable `.git` yields []. `workspace` is expected to be realpath'd already.
 */
export function gitWritableRoots(workspace: string, io: GitDirsIo = defaultIo): string[] {
  const dotGit = join(workspace, '.git')
  // A real `.git` directory sits inside the workspace and is already writable; a
  // missing `.git` means there's no out-of-tree git dir to widen the sandbox for.
  if (io.kindOf(dotGit) !== 'file') return []

  let pointer: string
  try {
    pointer = io.readText(dotGit)
  } catch {
    return []
  }
  const match = pointer.match(/^\s*gitdir:\s*(.+?)\s*$/m)
  if (!match) return []
  const gitDir = io.realpath(absolutize(match[1], workspace))

  const out: string[] = []
  const add = (dir: string): void => {
    if (!isWithin(workspace, dir) && !out.includes(dir)) out.push(dir)
  }
  add(gitDir)

  // The shared object store / refs live in the common dir, named (relative to the
  // git dir, usually `../..`) in `<gitDir>/commondir`. Absent for a plain submodule.
  try {
    const common = io.readText(join(gitDir, 'commondir')).trim()
    if (common) add(io.realpath(absolutize(common, gitDir)))
  } catch {
    // no commondir — the git dir alone is enough (e.g. a submodule)
  }
  return out
}
