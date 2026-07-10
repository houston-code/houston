import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { absolutize, defaultIo, type GitDirsIo } from './gitDirs'

/**
 * Resolving a workspace path to a stable REPO IDENTITY — a canonical key that is
 * the same for every checkout of one repository and different across repos.
 *
 * Houston has no first-class repo object: a workspace is a raw path string, and
 * the same repo reached through a symlink, an alternate absolute path, or a linked
 * worktree looks like three different workspaces. Anything that wants to remember
 * something "about this repo" (cross-session memory, per-repo config) needs one
 * key that survives those aliases. That key is the git COMMON DIR — the shared
 * `.git` object/ref store every linked worktree points back to. It is identical
 * for the main checkout and all its worktrees (including Houston's own
 * `.houston/worktrees/<slug>`), and it outlives any single worktree's teardown.
 *
 * Resolution is pure and synchronous (filesystem reads only, no `git` spawn) so it
 * can run at every run start cheaply and be unit-tested via the injectable
 * {@link GitDirsIo} seam shared with {@link gitWritableRoots}. It walks UP from the
 * workspace the way git does, so a workspace opened at a subdirectory still maps to
 * its enclosing repo. Never throws: an unreadable or non-git workspace falls back
 * to a `plain` identity keyed on its own canonical path.
 */

/** How high to walk looking for a `.git`, so a pathological path can't loop forever. */
const MAX_WALK_HOPS = 64

export interface RepoIdentity {
  /** `git` when a `.git` was found on the way up; `plain` for a non-git folder. */
  kind: 'git' | 'plain'
  /** The realpath'd input workspace (identity is canonical, never the raw path). */
  workspace: string
  /**
   * The main worktree root — the natural base for nesting/labelling. Equals
   * `workspace` for a plain folder; the common dir's parent for a linked worktree;
   * the directory holding `.git` otherwise.
   */
  root: string
  /** The realpath'd git common dir — the shared key anchor. Absent when `plain`. */
  commonDir?: string
  /** sha256 of `commonDir ?? workspace`, first 16 hex chars — the scope key. */
  key: string
}

/** First 16 hex chars of the anchor's sha256 — a short, collision-safe file/scope key. */
function hashKey(anchor: string): string {
  return createHash('sha256').update(anchor).digest('hex').slice(0, 16)
}

/**
 * Parse a `.git` FILE pointer (`gitdir: <path>`) to its absolute, realpath'd git
 * dir, or null when the file is unreadable or malformed (no `gitdir:` line) — in
 * which case the caller keeps ascending rather than treating it as a repo.
 */
function readGitDirPointer(dotGit: string, base: string, io: GitDirsIo): string | null {
  let pointer: string
  try {
    pointer = io.readText(dotGit)
  } catch {
    return null
  }
  const match = pointer.match(/^\s*gitdir:\s*(.+?)\s*$/m)
  if (!match) return null
  return io.realpath(absolutize(match[1], base))
}

/**
 * The common dir for a resolved git dir: the `commondir` file's target (a linked
 * worktree points back at the main repo's `.git`), or the git dir itself when there
 * is no `commondir` — a plain submodule has its own object store and is its own
 * common dir.
 */
function commonDirOf(gitDir: string, io: GitDirsIo): string {
  try {
    const common = io.readText(join(gitDir, 'commondir')).trim()
    if (common) return io.realpath(absolutize(common, gitDir))
  } catch {
    // no commondir file — a submodule's git dir is its own common dir
  }
  return gitDir
}

/**
 * Resolve a workspace path to its {@link RepoIdentity}. Pure aside from the
 * injectable filesystem seam. Two checkouts of one repo — the main worktree and any
 * linked worktree — yield the SAME `key` because both anchor on the shared common
 * dir; a subdirectory of either resolves to the same repo by walking up.
 */
export function resolveRepo(workspace: string, io: GitDirsIo = defaultIo): RepoIdentity {
  const ws = io.realpath(workspace)

  let dir = ws
  for (let hop = 0; hop < MAX_WALK_HOPS; hop++) {
    const dotGit = join(dir, '.git')
    const kind = io.kindOf(dotGit)

    if (kind === 'dir') {
      // Plain checkout: the `.git` DIRECTORY here is itself the common dir, and this
      // directory is the repo root.
      const commonDir = io.realpath(dotGit)
      return { kind: 'git', workspace: ws, root: dir, commonDir, key: hashKey(commonDir) }
    }

    if (kind === 'file') {
      const gitDir = readGitDirPointer(dotGit, dir, io)
      if (gitDir) {
        const commonDir = commonDirOf(gitDir, io)
        // For a linked worktree `commonDir` is `<mainRoot>/.git`, so the main
        // worktree root is its parent. For a submodule (commonDir === gitDir) that
        // parent is meaningless, so keep the working dir where `.git` was found.
        const root = commonDir === gitDir ? dir : dirname(commonDir)
        return { kind: 'git', workspace: ws, root, commonDir, key: hashKey(commonDir) }
      }
      // A malformed `.git` file names no repo — keep ascending; an ancestor may.
    }

    const parent = dirname(dir)
    if (parent === dir) break // reached the filesystem root
    dir = parent
  }

  // No git dir found anywhere up the tree: a plain, non-git workspace keyed on its
  // own canonical path (so symlink aliases of one folder still collapse to one key).
  return { kind: 'plain', workspace: ws, root: ws, key: hashKey(ws) }
}
