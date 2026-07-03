import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  slugifyBranch,
  worktreePath,
  getRepoInfo,
  createWorktree,
  removeWorktree,
  type GitRun
} from './worktree'

/** Build an injectable git runner from a map keyed by the first two argv tokens. */
function fakeGit(
  handlers: Record<string, (args: string[], cwd: string) => string>,
  calls: string[][] = []
): GitRun {
  return async (args, cwd) => {
    calls.push(args)
    const key = `${args[0]} ${args[1] ?? ''}`.trim()
    const h = handlers[key] ?? handlers[args[0]]
    if (!h) throw new Error(`unexpected git: ${args.join(' ')}`)
    return h(args, cwd)
  }
}

const worktreeList = (mainPath: string, branch = 'main', linked: string[] = []): string =>
  [
    `worktree ${mainPath}\nHEAD abc123\nbranch refs/heads/${branch}\n\n`,
    ...linked.map((p, i) => `worktree ${p}\nHEAD def45${i}\nbranch refs/heads/wt-${i}\n\n`)
  ].join('')

describe('slugifyBranch', () => {
  it('lowercases and replaces non-alphanumerics with dashes', () => {
    expect(slugifyBranch('Feature/Foo Bar')).toBe('feature-foo-bar')
  })
  it('trims leading/trailing dashes', () => {
    expect(slugifyBranch('--wip--')).toBe('wip')
  })
  it('falls back to "work" for punctuation-only input', () => {
    expect(slugifyBranch('///')).toBe('work')
  })
})

describe('worktreePath', () => {
  it('nests under .houston/worktrees in the repo root', () => {
    expect(worktreePath('/repo', 'feat-x', () => false)).toBe('/repo/.houston/worktrees/feat-x')
  })
  it('appends a numeric suffix until the path is free', () => {
    const taken = new Set(['/repo/.houston/worktrees/x', '/repo/.houston/worktrees/x-2'])
    expect(worktreePath('/repo', 'x', (p) => taken.has(p))).toBe('/repo/.houston/worktrees/x-3')
  })
})

describe('getRepoInfo', () => {
  // The paths below don't exist on the test machine, so force the existence probe
  // true to exercise the git branches (real-disk behaviour is covered separately).
  const onDisk = (): boolean => true

  it('returns the main worktree root, current branch, and branch list', async () => {
    const exec = fakeGit({
      'worktree list': () => worktreeList('/repo', 'main'),
      'rev-parse --abbrev-ref': () => 'feature\n',
      'for-each-ref': () => 'feature\nmain\nold\n'
    })
    const info = await getRepoInfo('/repo/sub', exec, onDisk)
    expect(info).toEqual({
      isRepo: true,
      root: '/repo',
      currentBranch: 'feature',
      branches: ['feature', 'main', 'old'],
      isLinkedWorktreeRoot: false,
      exists: true
    })
  })

  it('flags a linked worktree root, but not the main root or a subdirectory of one', async () => {
    const exec = fakeGit({
      'worktree list': () => worktreeList('/repo', 'main', ['/repo/.houston/worktrees/x']),
      'rev-parse --abbrev-ref': () => 'wt-0\n',
      'for-each-ref': () => 'main\n'
    })
    const at = async (ws: string): Promise<boolean> =>
      (await getRepoInfo(ws, exec, onDisk)).isLinkedWorktreeRoot
    expect(await at('/repo/.houston/worktrees/x')).toBe(true)
    // Trailing slashes don't hide the match.
    expect(await at('/repo/.houston/worktrees/x/')).toBe(true)
    expect(await at('/repo')).toBe(false)
    expect(await at('/repo/sub')).toBe(false)
    expect(await at('/repo/.houston/worktrees/x/sub')).toBe(false)
  })

  it('reports an existing non-repo folder as isRepo:false, exists:true', async () => {
    const exec: GitRun = async () => {
      throw new Error('not a git repository')
    }
    expect(await getRepoInfo('/tmp/x', exec, onDisk)).toEqual({
      isRepo: false,
      root: '',
      currentBranch: null,
      branches: [],
      isLinkedWorktreeRoot: false,
      exists: true
    })
  })

  it('short-circuits a missing directory to exists:false without spawning git', async () => {
    let called = false
    const exec: GitRun = async () => {
      called = true
      return ''
    }
    expect(await getRepoInfo('/gone', exec, () => false)).toEqual({
      isRepo: false,
      root: '',
      currentBranch: null,
      branches: [],
      isLinkedWorktreeRoot: false,
      exists: false
    })
    expect(called).toBe(false)
  })

  it('treats a detached HEAD as no current branch', async () => {
    const exec = fakeGit({
      'worktree list': () => worktreeList('/repo'),
      'rev-parse': () => 'HEAD\n',
      'for-each-ref': () => 'main\n'
    })
    const info = await getRepoInfo('/repo', exec, onDisk)
    expect(info.currentBranch).toBeNull()
  })
})

describe('createWorktree', () => {
  it('rejects an unsafe branch name before touching git', async () => {
    const exec: GitRun = async () => {
      throw new Error('should not be called')
    }
    await expect(createWorktree({ workspace: '/repo', branch: '--evil' }, exec)).rejects.toThrow(
      /Invalid branch name/
    )
  })

  it('rejects an unsafe base ref', async () => {
    const exec = fakeGit({ 'worktree list': () => worktreeList('/repo') })
    await expect(
      createWorktree({ workspace: '/repo', branch: 'ok', base: '--output=/etc/x' }, exec)
    ).rejects.toThrow(/Invalid base ref/)
  })

  it('throws when the workspace is not a git repo', async () => {
    const exec: GitRun = async (args) => {
      if (args[0] === 'worktree') throw new Error('not a repo')
      return ''
    }
    await expect(createWorktree({ workspace: '/x', branch: 'feat' }, exec)).rejects.toThrow(
      /not inside a git repository/
    )
  })

  it('creates the branch+worktree, excludes it, and returns metadata', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'wt-repo-'))
    // Pretend this is a real repo for the common-dir/exclude side effects.
    mkdirSync(join(repo, '.git'), { recursive: true })
    const calls: string[][] = []
    const exec = fakeGit(
      {
        'worktree list': () => worktreeList(repo, 'main'),
        'rev-parse --abbrev-ref': () => 'main\n',
        'for-each-ref': () => 'main\n',
        'rev-parse --git-common-dir': () => `${join(repo, '.git')}\n`,
        'worktree add': () => ''
      },
      calls
    )
    const wt = await createWorktree({ workspace: repo, branch: 'feature/login', base: 'main' }, exec)

    expect(wt.branch).toBe('feature/login')
    expect(wt.repoRoot).toBe(repo)
    expect(wt.path).toBe(join(repo, '.houston/worktrees/feature-login'))

    // The add command used -b <branch> <path> <base>, in that order.
    const add = calls.find((c) => c[0] === 'worktree' && c[1] === 'add')!
    expect(add).toEqual(['worktree', 'add', '-b', 'feature/login', wt.path, 'main'])

    // A `.git/info/exclude` entry keeps the nested worktree out of `git status`.
    const exclude = readFileSync(join(repo, '.git/info/exclude'), 'utf8')
    expect(exclude).toContain('/.houston/worktrees/')
  })

  it('omits the base argument when none is given', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'wt-repo-'))
    mkdirSync(join(repo, '.git'), { recursive: true })
    const calls: string[][] = []
    const exec = fakeGit(
      {
        'worktree list': () => worktreeList(repo),
        'rev-parse --abbrev-ref': () => 'main\n',
        'for-each-ref': () => 'main\n',
        'rev-parse --git-common-dir': () => join(repo, '.git'),
        'worktree add': () => ''
      },
      calls
    )
    const wt = await createWorktree({ workspace: repo, branch: 'wip' }, exec)
    const add = calls.find((c) => c[1] === 'add')!
    expect(add).toEqual(['worktree', 'add', '-b', 'wip', wt.path])
  })

  it('does not duplicate the exclude line on a second worktree', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'wt-repo-'))
    mkdirSync(join(repo, '.git/info'), { recursive: true })
    writeFileSync(join(repo, '.git/info/exclude'), '/.houston/worktrees/\n')
    const exec = fakeGit({
      'worktree list': () => worktreeList(repo),
      'rev-parse --abbrev-ref': () => 'main\n',
      'for-each-ref': () => 'main\n',
      'rev-parse --git-common-dir': () => join(repo, '.git'),
      'worktree add': () => ''
    })
    await createWorktree({ workspace: repo, branch: 'second' }, exec)
    const exclude = readFileSync(join(repo, '.git/info/exclude'), 'utf8')
    expect(exclude.match(/\/\.houston\/worktrees\//g)).toHaveLength(1)
  })
})

describe('removeWorktree', () => {
  const wt = { path: '/repo/.houston/worktrees/x', branch: 'feat/x', repoRoot: '/repo' }

  it('removes a clean worktree and its merged branch', async () => {
    const calls: string[][] = []
    const exec = fakeGit({ 'worktree remove': () => '', 'branch -d': () => '' }, calls)
    const res = await removeWorktree(wt, {}, exec)
    expect(res).toEqual({ removed: true, branchDeleted: true, message: undefined })
    expect(calls).toContainEqual(['worktree', 'remove', wt.path])
    expect(calls).toContainEqual(['branch', '-d', 'feat/x'])
  })

  it('keeps a dirty worktree instead of forcing it', async () => {
    const exec: GitRun = async (args) => {
      if (args[1] === 'remove') throw new Error('contains modified or untracked files')
      return ''
    }
    const res = await removeWorktree(wt, {}, exec)
    expect(res.removed).toBe(false)
    expect(res.branchDeleted).toBe(false)
    expect(res.message).toMatch(/modified or untracked/)
  })

  it('keeps an unmerged branch but still removes the worktree', async () => {
    const exec: GitRun = async (args) => {
      if (args[0] === 'branch') throw new Error('not fully merged')
      return ''
    }
    const res = await removeWorktree(wt, {}, exec)
    expect(res.removed).toBe(true)
    expect(res.branchDeleted).toBe(false)
    expect(res.message).toMatch(/unmerged commits/)
  })

  it('uses --force and -D when forced', async () => {
    const calls: string[][] = []
    const exec = fakeGit({ 'worktree remove': () => '', 'branch -D': () => '' }, calls)
    const res = await removeWorktree(wt, { force: true }, exec)
    expect(res.removed).toBe(true)
    expect(calls).toContainEqual(['worktree', 'remove', wt.path, '--force'])
    expect(calls).toContainEqual(['branch', '-D', 'feat/x'])
  })

  it('never throws even if the worktree is gone', async () => {
    const exec: GitRun = async () => {
      throw new Error('No such file or directory')
    }
    const res = await removeWorktree(wt, {}, exec)
    expect(res.removed).toBe(false)
  })
})

// End-to-end against real git: validates the actual command construction and
// filesystem effects the injected-exec tests can only assert indirectly.
describe('worktree integration (real git)', () => {
  let gitOk = true
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
  } catch {
    gitOk = false
  }
  const maybe = gitOk ? it : it.skip
  // Each case spawns several real git processes; under full-suite parallelism the
  // default 5s per-test timeout is too tight, so give them generous headroom.
  const TIMEOUT = 30_000

  /** Init a temp repo with one commit so HEAD exists to branch from. */
  function initRepo(): string {
    const repo = mkdtempSync(join(tmpdir(), 'wt-int-'))
    const g = (...args: string[]): void => {
      execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' })
    }
    g('-c', 'init.defaultBranch=main', 'init')
    g('config', 'user.email', 't@t.t')
    g('config', 'user.name', 'Test')
    writeFileSync(join(repo, 'README.md'), '# repo\n')
    g('add', 'README.md')
    g('-c', 'commit.gpgsign=false', 'commit', '-m', 'init')
    return repo
  }

  maybe('creates a worktree on disk and keeps the parent repo status clean', async () => {
    const repo = initRepo()
    try {
      const wt = await createWorktree({ workspace: repo, branch: 'feature/login' })
      // git normalizes paths to the realpath (e.g. /var → /private/var on macOS),
      // so compare the suffix rather than an exact prefix.
      expect(wt.path.endsWith('/.houston/worktrees/feature-login')).toBe(true)
      expect(wt.path).toBe(join(wt.repoRoot, '.houston/worktrees/feature-login'))
      expect(existsSync(wt.path)).toBe(true)
      // The branch is checked out in the worktree.
      const head = execFileSync('git', ['-C', wt.path, 'rev-parse', '--abbrev-ref', 'HEAD'], {
        encoding: 'utf8'
      }).trim()
      expect(head).toBe('feature/login')
      // The nested worktree is excluded, so the parent repo reports no changes.
      const status = execFileSync('git', ['-C', repo, 'status', '--porcelain'], {
        encoding: 'utf8'
      })
      expect(status.trim()).toBe('')

      // getRepoInfo (real git) sees the new branch and the same root.
      const info = await getRepoInfo(repo)
      expect(info.isRepo).toBe(true)
      expect(info.root).toBe(wt.repoRoot)
      expect(info.branches).toContain('feature/login')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, TIMEOUT)

  maybe('removes a clean worktree and its branch', async () => {
    const repo = initRepo()
    try {
      const wt = await createWorktree({ workspace: repo, branch: 'temp/x' })
      const res = await removeWorktree(wt)
      expect(res.removed).toBe(true)
      expect(res.branchDeleted).toBe(true)
      expect(existsSync(wt.path)).toBe(false)
      const branches = execFileSync('git', ['-C', repo, 'branch', '--format=%(refname:short)'], {
        encoding: 'utf8'
      })
      expect(branches).not.toContain('temp/x')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, TIMEOUT)

  maybe('keeps a dirty worktree instead of destroying uncommitted work', async () => {
    const repo = initRepo()
    try {
      const wt = await createWorktree({ workspace: repo, branch: 'dirty/x' })
      writeFileSync(join(wt.path, 'scratch.txt'), 'uncommitted work\n')
      const res = await removeWorktree(wt)
      expect(res.removed).toBe(false)
      expect(existsSync(wt.path)).toBe(true)
      // ...but a forced removal does tear it down.
      const forced = await removeWorktree(wt, { force: true })
      expect(forced.removed).toBe(true)
      expect(existsSync(wt.path)).toBe(false)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, TIMEOUT)
})
