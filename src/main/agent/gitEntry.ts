import { lstatSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * The nearest `.git` entry (directory, pointer file, or symlink) in `dir` or one of
 * its parents, or null when there is none. Used after git has already failed to open
 * `dir`: a `.git` here means the folder belongs to a repository git can't read (a
 * linked worktree whose admin files are gone, a repository owned by another user),
 * which must not be treated as a plain folder and offered a fresh `git init`.
 */
export function findGitEntry(
  dir: string,
  exists: (p: string) => boolean = (p) => lstatSync(p, { throwIfNoEntry: false }) !== undefined
): string | null {
  let d = dir
  for (;;) {
    const candidate = join(d, '.git')
    if (exists(candidate)) return candidate
    const up = dirname(d)
    if (up === d) return null
    d = up
  }
}

/** Longest git error shown to the user. */
const MAX_GIT_ERROR = 300

/**
 * The first line of git's error output, without its `fatal:` / `error:` prefix and
 * capped in length, for showing the user why git couldn't open a repository. Falls
 * back to a generic line when git printed nothing. Pure.
 */
export function gitErrorLine(stderr: string): string {
  const line = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean)
  if (!line) return 'git could not open it.'
  const text = line.replace(/^(fatal|error):\s*/i, '')
  return text.length > MAX_GIT_ERROR ? `${text.slice(0, MAX_GIT_ERROR - 1)}…` : text
}
