import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConversationWorktree } from '@shared/agent'
import {
  comeBackCommand,
  confirmsRemoval,
  createSessionWorktree,
  describeWork,
  finishSessionWorktree,
  parseKeepOrRemove,
  resumeWorktreeFolder,
  shellQuote,
  worktreeWork,
  type SessionWorktree
} from './sessionWorktree'

describe('session worktree helpers', () => {
  it('removes only on an explicit answer, and confirms only with the word', () => {
    expect(parseKeepOrRemove(null)).toBe('keep')
    expect(parseKeepOrRemove('')).toBe('keep')
    expect(parseKeepOrRemove('k')).toBe('keep')
    expect(parseKeepOrRemove('yes')).toBe('keep')
    expect(parseKeepOrRemove(' R ')).toBe('remove')
    expect(parseKeepOrRemove('remove')).toBe('remove')
    expect(confirmsRemoval('remove')).toBe(true)
    expect(confirmsRemoval(' REMOVE ')).toBe(true)
    expect(confirmsRemoval('y')).toBe(false)
    expect(confirmsRemoval('r')).toBe(false)
    expect(confirmsRemoval(null)).toBe(false)
  })

  it('quotes a path for the come-back command only when it needs it', () => {
    expect(shellQuote('/repo/.houston/worktrees/swift-otter-ab12cd')).toBe('/repo/.houston/worktrees/swift-otter-ab12cd')
    expect(shellQuote("/my repo/it's")).toBe(`'/my repo/it'\\''s'`)
    expect(comeBackCommand('/r/wt', 'abc')).toBe('houston --resume abc -C /r/wt')
    expect(comeBackCommand('/r/w t', null)).toBe("houston -C '/r/w t'")
  })

  it('describes the work a worktree holds', () => {
    expect(describeWork({ dirty: true, commits: 0 })).toBe('uncommitted changes')
    expect(describeWork({ dirty: false, commits: 1 })).toBe('1 commit')
    expect(describeWork({ dirty: true, commits: 3 })).toBe('3 commits and uncommitted changes')
  })

  it('opens a resumed worktree chat in its worktree, when it still exists', () => {
    const wt: ConversationWorktree = { path: '/r/.houston/worktrees/x', branch: 'x', repoRoot: '/r' }
    expect(resumeWorktreeFolder({ worktree: wt }, '/r', () => true)).toBe(wt.path)
    expect(resumeWorktreeFolder({ worktree: wt }, '/r/.houston/worktrees/x/', () => true)).toBeNull()
    expect(resumeWorktreeFolder({ worktree: wt }, '/r', () => false)).toBeNull()
    expect(resumeWorktreeFolder({}, '/r', () => true)).toBeNull()
    expect(resumeWorktreeFolder(null, '/r')).toBeNull()
  })

  it('keeps a worktree it cannot read', async () => {
    const wt: SessionWorktree = { path: '/gone', branch: 'b', repoRoot: '/r', base: 'abc1234' }
    expect(await worktreeWork(wt, async () => '', () => false)).toBeNull()
    expect(
      await worktreeWork(wt, async () => {
        throw new Error('boom')
      }, () => true)
    ).toBeNull()
    const out: string[] = []
    const removes: unknown[] = []
    const res = await finishSessionWorktree(wt, {
      out: (s) => out.push(s),
      ask: async () => 'remove',
      conversationId: 'c1',
      detach: () => {},
      exists: () => true,
      exec: async () => {
        throw new Error('git broke')
      },
      remove: async (w, o) => {
        removes.push([w, o])
        return { removed: true, branchDeleted: true }
      }
    })
    expect(res).toBe('kept')
    expect(removes).toEqual([])
    expect(out.join('')).toContain('come back with: houston --resume c1 -C /gone')
  })
})

// Against real git: what a session's worktree is made from, and what leaving does to it.
describe('session worktree (real git)', () => {
  let gitOk = true
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
  } catch {
    gitOk = false
  }
  const maybe = gitOk ? it : it.skip
  const TIMEOUT = 30_000

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', ['-C', cwd, '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim()

  function initRepo(): string {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'session-wt-')))
    git(repo, '-c', 'init.defaultBranch=main', 'init')
    git(repo, 'config', 'user.email', 't@t.t')
    git(repo, 'config', 'user.name', 'Test')
    writeFileSync(join(repo, 'README.md'), '# repo\n')
    git(repo, 'add', 'README.md')
    git(repo, 'commit', '-m', 'init')
    return repo
  }

  async function make(repo: string, name?: string): Promise<SessionWorktree> {
    const setup = await createSessionWorktree(repo, name)
    if (!setup.ok) throw new Error(setup.error)
    return setup.worktree
  }

  /** Finish with scripted answers, recording output and detached chats. */
  async function finish(wt: SessionWorktree, answers: Array<string | null>) {
    const out: string[] = []
    const asked: string[] = []
    const detached: ConversationWorktree[] = []
    const result = await finishSessionWorktree(wt, {
      out: (s) => out.push(s),
      ask: async (p) => {
        asked.push(p)
        return answers.shift() ?? null
      },
      conversationId: 'conv-9',
      detach: (w) => detached.push(w)
    })
    return { result, text: out.join(''), asked, detached }
  }

  const branchExists = (repo: string, branch: string): boolean =>
    git(repo, 'branch', '--list', branch) !== ''

  maybe(
    'creates the worktree where the desktop app does, on a generated branch from HEAD',
    async () => {
      const repo = initRepo()
      try {
        const wt = await make(repo)
        expect(wt.branch).toMatch(/^[a-z]+-[a-z]+-[a-z0-9]{6}$/)
        expect(wt.path).toBe(join(repo, '.houston', 'worktrees', wt.branch))
        expect(wt.repoRoot).toBe(repo)
        expect(wt.base).toBe(git(repo, 'rev-parse', 'HEAD'))
        expect(git(wt.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(wt.branch)
        // Kept out of the parent's status.
        expect(git(repo, 'status', '--porcelain')).toBe('')
      } finally {
        rmSync(repo, { recursive: true, force: true })
      }
    },
    TIMEOUT
  )

  maybe(
    'branches from the current folder HEAD, even inside a linked worktree on another branch',
    async () => {
      const repo = initRepo()
      try {
        const first = await make(repo, 'feature/one')
        writeFileSync(join(first.path, 'a.txt'), 'a\n')
        git(first.path, 'add', 'a.txt')
        git(first.path, 'commit', '-m', 'one')
        const second = await make(first.path, 'feature/two')
        expect(second.base).toBe(git(first.path, 'rev-parse', 'HEAD'))
        expect(second.path).toBe(join(repo, '.houston', 'worktrees', 'feature-two'))
        expect(existsSync(join(second.path, 'a.txt'))).toBe(true)
      } finally {
        rmSync(repo, { recursive: true, force: true })
      }
    },
    TIMEOUT
  )

  maybe(
    'refuses a folder outside git, a taken name, and a repository with no commits, as usage errors',
    async () => {
      const plain = realpathSync(mkdtempSync(join(tmpdir(), 'session-wt-plain-')))
      const repo = initRepo()
      const empty = realpathSync(mkdtempSync(join(tmpdir(), 'session-wt-empty-')))
      try {
        const notRepo = await createSessionWorktree(plain, undefined)
        expect(notRepo).toMatchObject({ ok: false, code: 2 })
        expect(!notRepo.ok && notRepo.error).toMatch(/needs a git repository/)

        const taken = await createSessionWorktree(repo, 'main')
        expect(taken).toMatchObject({ ok: false, code: 2 })
        expect(!taken.ok && taken.error).toMatch(/a branch named "main" already exists/)

        git(empty, 'init')
        const unborn = await createSessionWorktree(empty, 'x')
        expect(unborn).toMatchObject({ ok: false, code: 2 })
        expect(!unborn.ok && unborn.error).toMatch(/no commits yet/)
        expect(existsSync(join(empty, '.houston'))).toBe(false)

        expect(await createSessionWorktree(repo, '-x')).toMatchObject({ ok: false, code: 2 })
      } finally {
        for (const d of [plain, repo, empty]) rmSync(d, { recursive: true, force: true })
      }
    },
    TIMEOUT
  )

  maybe(
    'removes an unused worktree and its branch without asking',
    async () => {
      const repo = initRepo()
      try {
        const wt = await make(repo, 'idle')
        const f = await finish(wt, [])
        expect(f.result).toBe('removed')
        expect(f.asked).toEqual([])
        expect(existsSync(wt.path)).toBe(false)
        expect(branchExists(repo, 'idle')).toBe(false)
        expect(f.detached).toEqual([{ path: wt.path, branch: 'idle', repoRoot: repo }])
        expect(f.text).toContain('removed the unused worktree')
      } finally {
        rmSync(repo, { recursive: true, force: true })
      }
    },
    TIMEOUT
  )

  maybe(
    'keeps a worktree with work by default and says how to come back',
    async () => {
      const repo = initRepo()
      try {
        const wt = await make(repo, 'busy')
        writeFileSync(join(wt.path, 'new.txt'), 'draft\n')
        for (const answers of [[null], [''], ['k']]) {
          const f = await finish(wt, answers)
          expect(f.result).toBe('kept')
          expect(f.text).toContain('has uncommitted changes')
          expect(f.text).toContain(`come back with: houston --resume conv-9 -C ${wt.path}`)
          expect(f.detached).toEqual([])
        }
        expect(existsSync(join(wt.path, 'new.txt'))).toBe(true)
      } finally {
        rmSync(repo, { recursive: true, force: true })
      }
    },
    TIMEOUT
  )

  maybe(
    'removes uncommitted work only after the typed confirmation, keeping commits on the branch',
    async () => {
      const repo = initRepo()
      try {
        const wt = await make(repo, 'dirty')
        writeFileSync(join(wt.path, 'c.txt'), 'c\n')
        git(wt.path, 'add', 'c.txt')
        git(wt.path, 'commit', '-m', 'work')
        writeFileSync(join(wt.path, 'draft.txt'), 'unsaved\n')

        const declined = await finish(wt, ['r', 'yes'])
        expect(declined.result).toBe('kept')
        expect(declined.asked).toHaveLength(2)
        expect(existsSync(join(wt.path, 'draft.txt'))).toBe(true)

        const confirmed = await finish(wt, ['r', 'remove'])
        expect(confirmed.text).toContain('1 commit and uncommitted changes')
        expect(confirmed.result).toBe('removed')
        expect(existsSync(wt.path)).toBe(false)
        // The commit was not merged anywhere, so its branch stays.
        expect(branchExists(repo, 'dirty')).toBe(true)
      } finally {
        rmSync(repo, { recursive: true, force: true })
      }
    },
    TIMEOUT
  )

  maybe(
    'removes a worktree holding only commits on request, and its branch keeps them',
    async () => {
      const repo = initRepo()
      try {
        const wt = await make(repo, 'committed')
        writeFileSync(join(wt.path, 'd.txt'), 'd\n')
        git(wt.path, 'add', 'd.txt')
        git(wt.path, 'commit', '-m', 'work')
        const f = await finish(wt, ['remove'])
        expect(f.asked).toHaveLength(1)
        expect(f.result).toBe('removed')
        expect(existsSync(wt.path)).toBe(false)
        expect(branchExists(repo, 'committed')).toBe(true)
        expect(f.text).toContain('kept branch "committed"')
      } finally {
        rmSync(repo, { recursive: true, force: true })
      }
    },
    TIMEOUT
  )
})
