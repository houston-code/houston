import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveRepo } from './repoIdentity'
import type { GitDirsIo } from './gitDirs'

/**
 * Injectable {@link GitDirsIo} over in-memory maps. A path in `files` is a readable
 * file; a path in `dirs` is a directory; anything else is missing. `links` models
 * realpath (a symlink source -> its canonical target); unlisted paths realpath to
 * themselves.
 */
function fakeIo(
  files: Record<string, string>,
  dirs: string[] = [],
  links: Record<string, string> = {}
): GitDirsIo {
  return {
    kindOf: (p) => (p in files ? 'file' : dirs.includes(p) ? 'dir' : 'other'),
    readText: (p) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`)
      return files[p]
    },
    realpath: (p) => links[p] ?? p
  }
}

/** The expected 16-hex key for a given anchor, mirroring the module's derivation. */
function keyOf(anchor: string): string {
  return createHash('sha256').update(anchor).digest('hex').slice(0, 16)
}

describe('resolveRepo (injected io)', () => {
  it('resolves a plain checkout (.git is a directory) to itself as the common dir', () => {
    const io = fakeIo({}, ['/repo/.git'])
    const id = resolveRepo('/repo', io)
    expect(id).toEqual({
      kind: 'git',
      workspace: '/repo',
      root: '/repo',
      commonDir: '/repo/.git',
      key: keyOf('/repo/.git')
    })
  })

  it('gives a linked worktree the SAME key as its main checkout', () => {
    // One io models both the main repo (.git dir) and a worktree (.git file).
    const io = fakeIo(
      {
        '/repo/.houston/worktrees/feat/.git': 'gitdir: /repo/.git/worktrees/feat\n',
        '/repo/.git/worktrees/feat/commondir': '../..\n'
      },
      ['/repo/.git']
    )
    const main = resolveRepo('/repo', io)
    const worktree = resolveRepo('/repo/.houston/worktrees/feat', io)

    expect(main.key).toBe(keyOf('/repo/.git'))
    expect(worktree.key).toBe(main.key) // the headline property
    expect(worktree.commonDir).toBe('/repo/.git')
    expect(worktree.root).toBe('/repo')
    expect(worktree.kind).toBe('git')
  })

  it('maps a subdirectory of a plain repo up to the repo', () => {
    const io = fakeIo({}, ['/repo/.git'])
    const sub = resolveRepo('/repo/src/main', io)
    expect(sub.commonDir).toBe('/repo/.git')
    expect(sub.root).toBe('/repo')
    expect(sub.key).toBe(resolveRepo('/repo', io).key)
  })

  it('maps a subdirectory of a worktree up to the worktree (and its repo)', () => {
    const io = fakeIo(
      {
        '/repo/.houston/worktrees/feat/.git': 'gitdir: /repo/.git/worktrees/feat\n',
        '/repo/.git/worktrees/feat/commondir': '../..\n'
      },
      ['/repo/.git']
    )
    const deep = resolveRepo('/repo/.houston/worktrees/feat/src/lib', io)
    expect(deep.commonDir).toBe('/repo/.git')
    expect(deep.key).toBe(resolveRepo('/repo', io).key)
  })

  it('resolves a relative gitdir pointer against the workspace', () => {
    const io = fakeIo({
      '/repo/wt/.git': 'gitdir: ../.git/worktrees/wt\n',
      '/repo/.git/worktrees/wt/commondir': '../..\n'
    })
    const id = resolveRepo('/repo/wt', io)
    expect(id.commonDir).toBe('/repo/.git')
    expect(id.key).toBe(keyOf('/repo/.git'))
  })

  it('honors an absolute commondir pointer', () => {
    const io = fakeIo({
      '/a/wt/.git': 'gitdir: /elsewhere/git/worktrees/wt\n',
      '/elsewhere/git/worktrees/wt/commondir': '/elsewhere/git\n'
    })
    const id = resolveRepo('/a/wt', io)
    expect(id.commonDir).toBe('/elsewhere/git')
    expect(id.root).toBe('/elsewhere')
    expect(id.key).toBe(keyOf('/elsewhere/git'))
  })

  it('treats a submodule (.git file, no commondir) as its own common dir', () => {
    const io = fakeIo({ '/super/sub/.git': 'gitdir: /super/.git/modules/sub\n' })
    const id = resolveRepo('/super/sub', io)
    expect(id.kind).toBe('git')
    expect(id.commonDir).toBe('/super/.git/modules/sub')
    expect(id.root).toBe('/super/sub')
    expect(id.key).toBe(keyOf('/super/.git/modules/sub'))
  })

  it('falls back to the git dir when the commondir file is blank', () => {
    const io = fakeIo({
      '/repo/wt/.git': 'gitdir: /repo/.git/worktrees/wt\n',
      '/repo/.git/worktrees/wt/commondir': '\n'
    })
    const id = resolveRepo('/repo/wt', io)
    expect(id.commonDir).toBe('/repo/.git/worktrees/wt')
  })

  it('collapses symlink aliases of one folder to a single identity', () => {
    const io = fakeIo({}, ['/real/repo/.git'], { '/link/repo': '/real/repo' })
    const viaLink = resolveRepo('/link/repo', io)
    const viaReal = resolveRepo('/real/repo', io)
    expect(viaLink.workspace).toBe('/real/repo')
    expect(viaLink.commonDir).toBe('/real/repo/.git')
    expect(viaLink.key).toBe(viaReal.key)
  })

  it('keeps ascending past a malformed .git file to an enclosing repo', () => {
    const io = fakeIo({ '/repo/wt/.git': 'this is not a gitdir pointer\n' }, ['/repo/.git'])
    const id = resolveRepo('/repo/wt', io)
    expect(id.kind).toBe('git')
    expect(id.commonDir).toBe('/repo/.git')
    expect(id.root).toBe('/repo')
  })

  it('returns a plain identity for a non-git folder', () => {
    const io = fakeIo({})
    const id = resolveRepo('/plain/dir', io)
    expect(id).toEqual({
      kind: 'plain',
      workspace: '/plain/dir',
      root: '/plain/dir',
      key: keyOf('/plain/dir')
    })
    expect(id.commonDir).toBeUndefined()
  })

  it('returns a plain identity (no throw) for a malformed .git with no repo above', () => {
    const io = fakeIo({ '/lonely/.git': 'garbage\n' })
    const id = resolveRepo('/lonely', io)
    expect(id.kind).toBe('plain')
    expect(id.key).toBe(keyOf('/lonely'))
  })

  it('is deterministic and distinguishes distinct repos', () => {
    const io = fakeIo({}, ['/a/.git', '/b/.git'])
    expect(resolveRepo('/a', io).key).toBe(resolveRepo('/a', io).key)
    expect(resolveRepo('/a', io).key).not.toBe(resolveRepo('/b', io).key)
  })

  it('produces a 16-char lowercase hex key', () => {
    expect(resolveRepo('/anything', fakeIo({})).key).toMatch(/^[0-9a-f]{16}$/)
  })

  it('terminates on a deep path with no repo', () => {
    const deep = `/${Array.from({ length: 200 }, (_, i) => `d${i}`).join('/')}`
    const id = resolveRepo(deep, fakeIo({}))
    expect(id.kind).toBe('plain')
  })
})

describe('resolveRepo (real git)', () => {
  const hasGit = (() => {
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  })()

  it.runIf(hasGit)('gives a real worktree the same key as its main checkout', () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'houston-repoid-')))
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

      const mainId = resolveRepo(realpathSync(main))
      const wtId = resolveRepo(realpathSync(wt))

      expect(mainId.kind).toBe('git')
      expect(wtId.kind).toBe('git')
      expect(mainId.commonDir).toBe(realpathSync(join(main, '.git')))
      expect(wtId.commonDir).toBe(mainId.commonDir)
      expect(wtId.key).toBe(mainId.key)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it.runIf(hasGit)('gives a subdirectory the same key as the repo root', () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'houston-repoid-')))
    try {
      execFileSync('git', ['init', '-q', tmp], { stdio: 'ignore' })
      const sub = join(tmp, 'src', 'main')
      execFileSync('mkdir', ['-p', sub], { stdio: 'ignore' })
      expect(resolveRepo(sub).key).toBe(resolveRepo(tmp).key)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
