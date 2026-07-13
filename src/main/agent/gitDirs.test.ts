import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
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
    // A per-worktree dir has HEAD + commondir; the common dir has HEAD + objects.
    const io = fakeIo(
      {
        [join(ws, '.git')]: `gitdir: ${gitDir}\n`,
        [join(gitDir, 'HEAD')]: 'ref: refs/heads/feat\n',
        [join(gitDir, 'commondir')]: '../..\n',
        ['/repo/.git/HEAD']: 'ref: refs/heads/main\n'
      },
      ['/repo/.git/objects']
    )
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
    // A submodule git dir has its own HEAD + objects (no commondir file).
    const io = fakeIo(
      {
        [join(ws, '.git')]: `gitdir: ${gitDir}\n`,
        [join(gitDir, 'HEAD')]: 'ref: refs/heads/main\n'
      },
      [join(gitDir, 'objects')]
    )
    expect(gitWritableRoots(ws, io)).toEqual([gitDir])
  })

  it('resolves a relative gitdir pointer against the workspace', () => {
    const ws = '/repo/wt'
    const gitDir = '/repo/.git/worktrees/wt'
    const io = fakeIo(
      {
        [join(ws, '.git')]: 'gitdir: ../.git/worktrees/wt\n',
        [join(gitDir, 'HEAD')]: 'ref: refs/heads/wt\n',
        [join(gitDir, 'commondir')]: '../..\n',
        ['/repo/.git/HEAD']: 'ref: refs/heads/main\n'
      },
      ['/repo/.git/objects']
    )
    expect(gitWritableRoots(ws, io)).toEqual([gitDir, '/repo/.git'])
  })

  it('honors an absolute commondir pointer', () => {
    const ws = '/a/wt'
    const gitDir = '/elsewhere/git/worktrees/wt'
    const io = fakeIo(
      {
        [join(ws, '.git')]: `gitdir: ${gitDir}\n`,
        [join(gitDir, 'HEAD')]: 'ref: refs/heads/wt\n',
        [join(gitDir, 'commondir')]: '/elsewhere/git\n',
        ['/elsewhere/git/HEAD']: 'ref: refs/heads/main\n'
      },
      ['/elsewhere/git/objects']
    )
    expect(gitWritableRoots(ws, io)).toEqual([gitDir, '/elsewhere/git'])
  })

  it('drops a git dir that already lives inside the workspace', () => {
    const ws = '/repo'
    const gitDir = '/repo/nested/.git'
    // A `.git` *file* pointing back inside the workspace adds nothing new.
    const io = fakeIo(
      {
        [join(ws, '.git')]: 'gitdir: /repo/nested/.git\n',
        [join(gitDir, 'HEAD')]: 'ref: refs/heads/main\n',
        [join(gitDir, 'commondir')]: '.\n'
      },
      [join(gitDir, 'objects')]
    )
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
    const io = fakeIo(
      {
        [join(ws, '.git')]: `gitdir: ${gitDir}`,
        [join(gitDir, 'HEAD')]: 'ref: refs/heads/wt\n',
        [join(gitDir, 'commondir')]: '\n'
      },
      [join(gitDir, 'objects')]
    )
    expect(gitWritableRoots(ws, io)).toEqual([gitDir])
  })

  // --- SECURITY: hostile `.git` pointer files must not widen the writable roots
  // (HTN-H-01). A `.git` *file* is attacker-controlled when an untrusted project is
  // opened (e.g. delivered inside an archive), so a pointer must only ever resolve
  // to a directory that genuinely IS a git dir. ---

  it('refuses a `.git` file that points at the filesystem root', () => {
    const ws = '/evil/project'
    const io = fakeIo({ [join(ws, '.git')]: 'gitdir: /\n' })
    expect(gitWritableRoots(ws, io)).toEqual([])
  })

  it('refuses a gitdir target that is not a real git dir', () => {
    const ws = '/evil/project'
    // `/tmp/loot` exists as a directory but has no HEAD, so it is not a git dir.
    const io = fakeIo({ [join(ws, '.git')]: 'gitdir: /tmp/loot\n' }, ['/tmp/loot'])
    expect(gitWritableRoots(ws, io)).toEqual([])
  })

  it('refuses the filesystem root even if it is dressed up to look like a git dir', () => {
    const ws = '/evil/project'
    const io = fakeIo({ [join(ws, '.git')]: 'gitdir: /\n', ['/HEAD']: 'x\n' }, ['/objects'])
    expect(gitWritableRoots(ws, io)).toEqual([])
  })

  it('refuses the home directory even if it is dressed up to look like a git dir', () => {
    const ws = '/evil/project'
    const home = homedir()
    const io = fakeIo(
      { [join(ws, '.git')]: `gitdir: ${home}\n`, [join(home, 'HEAD')]: 'x\n' },
      [join(home, 'objects')]
    )
    expect(gitWritableRoots(ws, io)).toEqual([])
  })

  it('drops a crafted commondir that is not itself a real git dir', () => {
    const ws = '/repo/wt'
    const gitDir = '/repo/.git/worktrees/wt'
    // The git dir itself is valid, but its commondir points at `/` — not a git dir —
    // so only the (validated) git dir is returned, never `/`.
    const io = fakeIo({
      [join(ws, '.git')]: `gitdir: ${gitDir}\n`,
      [join(gitDir, 'HEAD')]: 'ref: refs/heads/wt\n',
      [join(gitDir, 'commondir')]: '/\n'
    })
    expect(gitWritableRoots(ws, io)).toEqual([gitDir])
  })
})

// These integration tests each spawn ~5 real git subprocesses (init, config x2,
// commit, worktree add). Under the full parallel suite on a busy machine those
// synchronous spawns starve and blow past Vitest's 5s default (observed ~6-8s),
// even though each passes comfortably in isolation and in CI. Give them generous
// headroom so subprocess scheduling jitter can't flake the run.
const REAL_GIT_TIMEOUT = 30_000

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
  }, REAL_GIT_TIMEOUT)

  it.runIf(hasGit)('returns [] for a plain (non-worktree) checkout', () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'houston-gitdirs-')))
    try {
      execFileSync('git', ['init', '-q', tmp], { stdio: 'ignore' })
      expect(gitWritableRoots(tmp)).toEqual([])
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }, REAL_GIT_TIMEOUT)
})
