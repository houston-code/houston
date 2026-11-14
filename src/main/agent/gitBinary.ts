import { accessSync, constants, readlinkSync, statSync } from 'node:fs'

/**
 * Which program to start for a git command.
 *
 * On macOS, `/usr/bin/git` is not git itself but a small launcher that looks up the
 * selected developer tools and starts the git inside them. That lookup costs about 10 ms
 * on every call, and an app started from the Dock or Finder has `/usr/bin` near the front
 * of its PATH, so nearly every git call Houston makes paid it. When the git a PATH lookup
 * would find is exactly that launcher, {@link gitExecutable} names the developer tools'
 * own git instead: the binary the launcher would have started, with the same arguments.
 * (The launcher also adds compiler variables such as `SDKROOT` to git's environment; the
 * programs Houston's hardened git calls can start, such as a credential helper, ssh, or
 * gpg, don't read them.) In every other case (another git first on PATH, no selected
 * developer tools, any other platform) it returns `'git'`, and the spawn looks git up on
 * PATH as it always has.
 *
 * The developer directory is the one the launcher reads: `DEVELOPER_DIR` when set, else
 * the target of `/var/db/xcode_select_link` (written by `xcode-select --switch`). `xcrun`
 * is never run: it is the slow part, and without developer tools it can open the install
 * dialog.
 */

/** The macOS launcher that forwards to the selected developer tools. */
export const XCRUN_LAUNCHER_GIT = '/usr/bin/git'

/** Where `xcode-select --switch` records the selected developer directory. */
export const XCODE_SELECT_LINK = '/var/db/xcode_select_link'

/** The search path a spawn uses when its environment has no PATH (`_PATH_DEFPATH`). */
const DEFAULT_SEARCH_PATH = '/usr/bin:/bin'

/** Filesystem reads the lookup makes; injected in tests. */
export interface GitBinaryProbe {
  platform: NodeJS.Platform
  /** Whether `path` is a regular file this process may execute (following symlinks). */
  isExecutable: (path: string) => boolean
  /** The target of the symbolic link at `path`, or null when there is none. */
  readLink: (path: string) => string | null
}

/** The spawn's environment: its PATH and DEVELOPER_DIR decide which git runs. */
export type GitLookupEnv = Readonly<Record<string, string | undefined>>

const realProbe: GitBinaryProbe = {
  platform: process.platform,
  isExecutable: (path) => {
    try {
      if (!statSync(path).isFile()) return false
      accessSync(path, constants.X_OK)
      return true
    } catch {
      return false
    }
  },
  readLink: (path) => {
    try {
      return readlinkSync(path)
    } catch {
      return null
    }
  }
}

/** `dir/name`, joined the way a spawn's PATH search joins them (no normalizing). */
const under = (dir: string, name: string): string => `${dir.replace(/\/+$/, '')}/${name}`

/**
 * The developer tools' git when the first executable `git` on the environment's PATH is
 * the launcher, else null. The PATH walk is the spawn's own: entries in order, a
 * directory or a file without execute permission skipped. An empty or relative entry is
 * looked up from the spawn's working directory, which this can't know, so it ends the
 * walk with null.
 */
function developerGit(env: GitLookupEnv, probe: GitBinaryProbe): string | null {
  let first: string | null = null
  for (const dir of (env.PATH ?? DEFAULT_SEARCH_PATH).split(':')) {
    if (!dir.startsWith('/')) return null
    if (probe.isExecutable(under(dir, 'git'))) {
      first = under(dir, 'git')
      break
    }
  }
  if (first !== XCRUN_LAUNCHER_GIT) return null
  const devDir = env.DEVELOPER_DIR ?? probe.readLink(XCODE_SELECT_LINK)
  if (!devDir?.startsWith('/')) return null
  const git = under(devDir, 'usr/bin/git')
  return git !== XCRUN_LAUNCHER_GIT && probe.isExecutable(git) ? git : null
}

/** A memoized {@link gitExecutable} over `probe`; exported for tests. */
export function makeGitExecutable(probe: GitBinaryProbe = realProbe): (env?: GitLookupEnv) => string {
  const memo = new Map<string, string | null>()
  return (env = process.env) => {
    if (probe.platform !== 'darwin') return 'git'
    const key = JSON.stringify([env.PATH ?? null, env.DEVELOPER_DIR ?? null])
    let git = memo.get(key)
    // A remembered developer git that has since gone (developer tools moved or removed)
    // is looked up again rather than spawned and failed.
    if (git === undefined || (git !== null && !probe.isExecutable(git))) {
      git = developerGit(env, probe)
      if (memo.size >= 16) memo.clear()
      memo.set(key, git)
    }
    return git ?? 'git'
  }
}

/**
 * The program to start for git under `env`, the environment the spawn is given (its PATH
 * and DEVELOPER_DIR decide the answer, so pass the same object): an absolute path to the
 * developer tools' git where `'git'` would have started the macOS launcher, else `'git'`.
 * Remembered per PATH and DEVELOPER_DIR.
 */
export const gitExecutable = makeGitExecutable()
