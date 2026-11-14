import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readHeadBranch } from './headBranch'

const SHA1 = '3f786850e387550fdab836ed7e6dc881de23001b'

let dir = ''
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'houston-head-')))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A repository whose git directory holds just a HEAD file with `head` in it. */
function repo(at: string, head: string | null): string {
  mkdirSync(join(at, '.git'), { recursive: true })
  if (head !== null) writeFileSync(join(at, '.git', 'HEAD'), head)
  return at
}

describe('readHeadBranch', () => {
  it('names the branch HEAD points at, from the repository root or below it', () => {
    repo(dir, 'ref: refs/heads/main\n')
    mkdirSync(join(dir, 'src', 'deep'), { recursive: true })
    expect(readHeadBranch(dir, {})).toBe('main')
    expect(readHeadBranch(join(dir, 'src', 'deep'), {})).toBe('main')
  })

  it('keeps the slashes of a branch name', () => {
    repo(dir, 'ref: refs/heads/feature/login-form\n')
    expect(readHeadBranch(dir, {})).toBe('feature/login-form')
  })

  it('reports no branch on a detached HEAD, SHA-1 or SHA-256', () => {
    repo(dir, `${SHA1}\n`)
    expect(readHeadBranch(dir, {})).toBeNull()
    repo(dir, `${'ab'.repeat(32)}\n`)
    expect(readHeadBranch(dir, {})).toBeNull()
  })

  it('reports no branch outside a repository', () => {
    expect(readHeadBranch(dir, {})).toBeNull()
  })

  it('follows the .git file of a linked worktree to its own HEAD, absolute or relative', () => {
    const main = repo(join(dir, 'main'), 'ref: refs/heads/main\n')
    const wtGit = join(main, '.git', 'worktrees', 'wt')
    mkdirSync(wtGit, { recursive: true })
    writeFileSync(join(wtGit, 'HEAD'), 'ref: refs/heads/topic\n')
    const wt = join(dir, 'wt')
    mkdirSync(join(wt, 'sub'), { recursive: true })
    writeFileSync(join(wt, '.git'), `gitdir: ${wtGit}\n`)
    expect(readHeadBranch(join(wt, 'sub'), {})).toBe('topic')
    writeFileSync(join(wt, '.git'), 'gitdir: ../main/.git/worktrees/wt\n')
    expect(readHeadBranch(wt, {})).toBe('topic')
  })

  it('hands back to git when the files cannot answer', () => {
    // No HEAD at all.
    repo(dir, null)
    expect(readHeadBranch(dir, {})).toBeUndefined()
    // A reftable repository's placeholder, a ref outside refs/heads, anything else.
    for (const head of ['ref: refs/heads/.invalid\n', 'ref: refs/remotes/origin/main\n', 'garbage\n', '']) {
      repo(dir, head)
      expect(readHeadBranch(dir, {}), head).toBeUndefined()
    }
    // A .git file that names no directory, or one that is gone.
    const wt = join(dir, 'wt')
    mkdirSync(wt)
    writeFileSync(join(wt, '.git'), 'not a pointer\n')
    expect(readHeadBranch(wt, {})).toBeUndefined()
    writeFileSync(join(wt, '.git'), `gitdir: ${join(dir, 'gone')}\n`)
    expect(readHeadBranch(wt, {})).toBeUndefined()
  })

  it('hands back to git when the environment changes where git looks', () => {
    repo(dir, 'ref: refs/heads/main\n')
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_CEILING_DIRECTORIES', 'GIT_COMMON_DIR']) {
      expect(readHeadBranch(dir, { [name]: '/elsewhere' }), name).toBeUndefined()
    }
  })

  // The same answers git itself gives, on repositories git made.
  it('agrees with git symbolic-ref on a real repository, a linked worktree and a detached one', () => {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dir, 'no-config') }
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_CEILING_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) {
      delete env[name]
    }
    const git = (cwd: string, ...args: string[]): string =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
        cwd,
        env,
        encoding: 'utf8'
      })
    const symbolic = (cwd: string): string | null => {
      try {
        return git(cwd, 'symbolic-ref', '--short', '-q', 'HEAD').trim() || null
      } catch {
        return null
      }
    }
    const main = join(dir, 'main')
    mkdirSync(main)
    git(main, 'init', '-q', '-b', 'trunk')
    expect(readHeadBranch(main, {})).toBe('trunk') // unborn
    git(main, 'commit', '-q', '--allow-empty', '-m', 'first')
    git(main, 'worktree', 'add', '-q', '-b', 'topic/one', join(dir, 'linked'))
    git(main, 'worktree', 'add', '-q', '--detach', join(dir, 'detached'))
    for (const at of [main, join(dir, 'linked'), join(dir, 'detached')]) {
      expect(readHeadBranch(at, {}), at).toBe(symbolic(at))
    }
    expect(readHeadBranch(join(dir, 'linked'), {})).toBe('topic/one')
    expect(readHeadBranch(join(dir, 'detached'), {})).toBeNull()
  })
})
