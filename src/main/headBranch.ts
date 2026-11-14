import { readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/**
 * The branch a repository's HEAD names, read from its HEAD file, for the terminal
 * status line. The branch is display-only, so this reads files and runs no git
 * program: no spawn, nothing a repository's config can make run, and fast enough to
 * read before every prompt.
 *
 * Finds the repository the way git does from `cwd`: the nearest `.git` at or above it,
 * either a directory or a file pointing at the real git directory (`gitdir: <path>`, as
 * in a linked worktree or a submodule). Returns:
 *   - the branch for `ref: refs/heads/<branch>` (also an unborn one, as git does);
 *   - null on a detached HEAD (a commit id) or outside a repository;
 *   - undefined when the files can't answer: a HEAD that is missing, unreadable or in a
 *     form this doesn't read (a reftable repository's placeholder, a ref outside
 *     refs/heads), a `.git` file that names no directory, or GIT_DIR and the other
 *     variables that change where git looks. The caller asks git instead.
 */
export function readHeadBranch(cwd: string, env: NodeJS.ProcessEnv = process.env): string | null | undefined {
  if (env.GIT_DIR || env.GIT_WORK_TREE || env.GIT_CEILING_DIRECTORIES || env.GIT_COMMON_DIR) return undefined
  const gitDir = findGitDir(resolve(cwd))
  if (gitDir === null || gitDir === undefined) return gitDir
  let head: string
  try {
    head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
  } catch {
    return undefined
  }
  if (/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(head)) return null
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)?.[1]
  // A reftable repository keeps HEAD in its tables and this placeholder in the file.
  if (!ref || ref === '.invalid') return undefined
  return ref
}

/** The git directory for `dir`: null when no `.git` is found, undefined when one can't be read. */
function findGitDir(dir: string): string | null | undefined {
  for (let at = dir; ; at = dirname(at)) {
    const dotGit = join(at, '.git')
    let isDir: boolean
    try {
      isDir = statSync(dotGit).isDirectory()
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return undefined
      if (dirname(at) === at) return null
      continue
    }
    if (isDir) return dotGit
    try {
      const target = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]?.trim()
      if (!target) return undefined
      return isAbsolute(target) ? target : resolve(at, target)
    } catch {
      return undefined
    }
  }
}
