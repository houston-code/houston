import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitWritableRoots, type GitDirsIo } from './gitDirs'

/**
 * Build an injectable {@link GitDirsIo} over an in-memory `path -> contents` map.
 * A path present in the map is a readable file; a path in `dirs` is a directory;
 * anything else is 'other' (missing). realpath is identity (no symlinks to model).
 */
function fakeIo(files: Record<string, string>, dirs: string[] = []): GitDirsIo {
  return {
    kindOf: (p) => (p in files ? 'file' : dirs.includes(p) ? 'dir' : 'other'),
    readText: (p) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`)
      return files[p]
    },
    realpath: (p) => p
  }
}

describe('gitWritableRoots (injected io)', () => {
  it('returns the worktree git dir AND the common dir for a linked worktree', () => {
    const ws = '/repo/.worktrees/feat'
    const gitDir = '/repo/.git/worktrees/feat'
    const io = fakeIo({
      [join(ws, '.git')]: `gitdir: ${gitDir}\n`,
      [join(gitDir, 'commondir')]: '../..\n'
    })
    // commondir `../..` resolved against the git dir = the main repo's `.git`.
    expect(gitWritableRoots(ws, io)).toEqual([gitDir, '/repo/.git'])
  })

  it('returns [] for a plain checkout (.git is a real directory)', () => {
    const ws = '/repo'
    const io = fakeIo({}, [join(ws, '.git')])
    expect(gitWritableRoots(ws, io)).toEqual([])
  })

  it('returns [] when the workspace is not a repo (no .git)', () => {
    expect(gitWritableRoots('/not/a/repo', fakeIo({}))).toEqual([])
  })

  it('returns only the git dir for a submodule (no commondir file)', () => {
    const ws = '/super/sub'
    const gitDir = '/super/.git/modules/sub'
    const io = fakeIo({ [join(ws, '.git')]: `gitdir: ${gitDir}\n` })
    expect(gitWritableRoots(ws, io)).toEqual([gitDir])
  })

  it('resolves a relative gitdir pointer against the workspace', () => {
    const ws = '/repo/wt'
    const io = fakeIo({
      [join(ws, '.git')]: 'gitdir: ../.git/worktrees/wt\n',
      ['/repo/.git/worktrees/wt/commondir']: '../..\n'
    })
    expect(gitWritableRoots(ws, io)).toEqual(['/repo/.git/worktrees/wt', '/repo/.git'])
  })

  it('honors an absolute commondir pointer', () => {
    const ws = '/a/wt'
    const gitDir = '/elsewhere/git/worktrees/wt'
    const io = fakeIo({
      [join(ws, '.git')]: `gitdir: ${gitDir}\n`,
      [join(gitDir, 'commondir')]: '/elsewhere/git\n'
    })
    expect(gitWritableRoots(ws, io)).toEqual([gitDir, '/elsewhere/git'])
  })

  it('drops a git dir that already lives inside the workspace', () => {
    const ws = '/repo'
    // A `.git` *file* pointing back inside the workspace adds nothing new.
    const io = fakeIo({
      [join(ws, '.git')]: 'gitdir: /repo/nested/.git\n',
      ['/repo/nested/.git/commondir']: '.\n'
    })
    expect(gitWritableRoots(ws, io)).toEqual([])
  })

  it('returns [] for a malformed .git pointer (no gitdir: line)', () => {
    const ws = '/repo/wt'
    const io = fakeIo({ [join(ws, '.git')]: 'this is not a gitdir pointer\n' })
    expect(gitWritableRoots(ws, io)).toEqual([])
  })

  it('ignores a blank commondir file', () => {
    const ws = '/repo/wt'
    const gitDir = '/repo/.git/worktrees/wt'
    const io = fakeIo({
      [join(ws, '.git')]: `gitdir: ${gitDir}`,
      [join(gitDir, 'commondir')]: '\n'
    })
    expect(gitWritableRoots(ws, io)).toEqual([gitDir])
  })
})

describe('gitWritableRoots (real git worktree)', () => {
  const hasGit = (() => {
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  })()

  it.runIf(hasGit)('resolves the real per-worktree dir and common dir', () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'houston-gitdirs-')))
    try {
      const main = join(tmp, 'main')
      const git = (args: string[], cwd: string): void => {
        execFileSync('git', args, { cwd, stdio: 'ignore' })
      }
      execFileSync('git', ['init', '-q', main], { stdio: 'ignore' })
      git(['config', 'user.email', 't@t'], main)
      git(['config', 'user.name', 't'], main)
      git(['commit', '-q', '--allow-empty', '-m', 'init'], main)
      const wt = join(tmp, 'wt')
      git(['worktree', 'add', '-q', '-b', 'feat', wt], main)

      const roots = gitWritableRoots(realpathSync(wt))
      const commonDir = realpathSync(join(main, '.git'))
      const worktreeDir = join(commonDir, 'worktrees', 'wt')
      expect(roots).toContain(worktreeDir)
      expect(roots).toContain(commonDir)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it.runIf(hasGit)('returns [] for a plain (non-worktree) checkout', () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'houston-gitdirs-')))
    try {
      execFileSync('git', ['init', '-q', tmp], { stdio: 'ignore' })
      expect(gitWritableRoots(tmp)).toEqual([])
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
