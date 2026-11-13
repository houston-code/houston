import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Provider, ProviderStreamEvent } from '@shared/agent'

const host = vi.hoisted(() => ({
  provider: { id: 'p', kind: 'openai-compatible', models: [{ id: 'm' }] } as unknown,
  selected: { providerId: 'p', model: 'm' } as { providerId: string; model: string } | null
}))
vi.mock('../agentHost', () => ({
  getProvider: (id: string) => (id === 'p' ? host.provider : undefined),
  getSettings: () => ({ selected: host.selected })
}))
vi.mock('../conversations', () => ({ peekConversation: () => null }))

import {
  branchSync,
  commitAll,
  commitMessageRequest,
  lookupPr,
  pushBranch,
  pushEnv,
  riskyRepoConfig,
  sanitizeCommitMessage,
  suggestCommitMessage
} from './gitActions'

let gitOk = true
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' })
} catch {
  gitOk = false
}
const maybe = gitOk ? it : it.skip
const TIMEOUT = 30_000

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function tmp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  dirs.push(d)
  return d
}
const git = (repo: string, ...args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()

function repo(): string {
  const r = tmp('ga-')
  git(r, '-c', 'init.defaultBranch=main', 'init', '-q')
  git(r, 'config', 'user.email', 't@t.t')
  git(r, 'config', 'user.name', 'Test')
  git(r, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(r, 'a.txt'), 'one\n')
  git(r, 'add', '.')
  git(r, 'commit', '-qm', 'init')
  return r
}
const deps = (known: string[]) => ({ knownWorkspace: (w: string) => known.includes(w) })

describe('riskyRepoConfig', () => {
  it('names repository-level keys that can run a command, ignoring the user’s own config', () => {
    const out = [
      'local', 'core.sshcommand\nevil',
      'local', 'user.name\nme',
      'global', 'credential.helper\nosxkeychain',
      'worktree', 'gpg.program\nx',
      'local', 'include.path\n../x',
      ''
    ].join('\0')
    expect(riskyRepoConfig(out)).toEqual(['core.sshcommand', 'gpg.program', 'include.path'])
    expect(riskyRepoConfig('')).toEqual([])
  })
})

describe('commitAll', () => {
  maybe(
    'stages every change, commits it, and skips repository hooks',
    async () => {
      const r = repo()
      writeFileSync(join(r, 'a.txt'), 'two\n')
      writeFileSync(join(r, 'new.txt'), 'new\n')
      const marker = join(r, 'hook-ran')
      const hook = join(r, '.git', 'hooks', 'pre-commit')
      writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\n`)
      chmodSync(hook, 0o755)
      const res = await commitAll(r, '  Update a\r\n\r\nAnd add new  ', deps([r]))
      expect(res).toMatchObject({ ok: true, detail: expect.stringMatching(/^[0-9a-f]{7,}$/) })
      expect(git(r, 'log', '-1', '--format=%B')).toBe('Update a\n\nAnd add new')
      expect(git(r, 'status', '--porcelain')).toBe('')
      expect(existsSync(marker)).toBe(false)
    },
    TIMEOUT
  )

  maybe(
    'refuses an empty message, an unknown folder, and a repository config that runs a command',
    async () => {
      const r = repo()
      writeFileSync(join(r, 'a.txt'), 'two\n')
      expect(await commitAll(r, '   ', deps([r]))).toMatchObject({ ok: false, error: /commit message/ })
      expect(await commitAll(r, 'x', deps([]))).toMatchObject({ ok: false, error: 'Unknown project folder.' })
      git(r, 'config', 'gpg.program', 'definitely-not-run')
      const res = await commitAll(r, 'x', deps([r]))
      expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/gpg\.program/) })
      expect(git(r, 'rev-list', '--count', 'HEAD')).toBe('1')
    },
    TIMEOUT
  )

  maybe(
    'refuses while a merge is in progress, instead of committing its conflict markers',
    async () => {
      const r = repo()
      git(r, 'checkout', '-qb', 'other')
      writeFileSync(join(r, 'a.txt'), 'other\n')
      git(r, 'commit', '-qam', 'other')
      git(r, 'checkout', '-q', 'main')
      writeFileSync(join(r, 'a.txt'), 'mine\n')
      git(r, 'commit', '-qam', 'mine')
      const head = git(r, 'rev-parse', 'HEAD')
      expect(() => execFileSync('git', ['-C', r, 'merge', '-q', 'other'], { stdio: 'ignore' })).toThrow()
      const res = await commitAll(r, 'Merge', deps([r]))
      expect(res).toMatchObject({ ok: false, error: /conflicts/ })
      expect(git(r, 'rev-parse', 'HEAD')).toBe(head)
      expect(git(r, 'ls-files', '-u')).not.toBe('')
      // Conflicts resolved by hand but the merge not concluded: still refused.
      writeFileSync(join(r, 'a.txt'), 'resolved\n')
      git(r, 'add', 'a.txt')
      expect(await commitAll(r, 'Merge', deps([r]))).toMatchObject({ ok: false, error: /in progress/ })
      expect(git(r, 'rev-parse', 'HEAD')).toBe(head)
    },
    TIMEOUT
  )
})

describe('pushBranch and branchSync', () => {
  maybe(
    'publishes a branch on its first push, then pushes new commits to its upstream',
    async () => {
      const remote = tmp('ga-remote-')
      execFileSync('git', ['init', '-q', '--bare', remote])
      const r = repo()
      git(r, 'remote', 'add', 'origin', remote)
      expect(await branchSync(r)).toEqual({ branch: 'main', upstream: null, ahead: 1, remote: 'origin' })
      expect(await pushBranch(r, deps([r]))).toEqual({ ok: true, detail: 'origin/main' })
      expect(await branchSync(r)).toMatchObject({ upstream: 'origin/main', ahead: 0 })
      writeFileSync(join(r, 'a.txt'), 'two\n')
      await commitAll(r, 'Two', deps([r]))
      expect(await branchSync(r)).toMatchObject({ ahead: 1 })
      expect(await pushBranch(r, deps([r]))).toEqual({ ok: true, detail: 'origin/main' })
      expect(execFileSync('git', ['-C', remote, 'log', '-1', '--format=%s', 'main'], { encoding: 'utf8' }).trim()).toBe('Two')
    },
    TIMEOUT
  )

  maybe(
    'refuses with no remote, and when the repository sets its own ssh command',
    async () => {
      const r = repo()
      expect(await pushBranch(r, deps([r]))).toMatchObject({ ok: false, error: /no remote/ })
      git(r, 'remote', 'add', 'origin', join(r, 'nowhere'))
      git(r, 'config', 'core.sshCommand', 'touch pwned')
      expect(await pushBranch(r, deps([r]))).toMatchObject({ ok: false, error: /core\.sshcommand/ })
    },
    TIMEOUT
  )

  maybe(
    'pushes a branch that tracks a differently named one to its own name',
    async () => {
      for (const pushDefault of ['simple', 'upstream']) {
        const remote = tmp('ga-remote-')
        execFileSync('git', ['init', '-q', '--bare', remote])
        const r = repo()
        git(r, 'remote', 'add', 'origin', remote)
        git(r, 'push', '-q', 'origin', 'main')
        git(r, 'fetch', '-q', 'origin')
        git(r, 'config', 'push.default', pushDefault)
        git(r, 'switch', '-q', '-c', 'feat', 'origin/main')
        writeFileSync(join(r, 'a.txt'), 'feat\n')
        git(r, 'commit', '-qam', 'Feat')
        expect(await pushBranch(r, deps([r]))).toEqual({ ok: true, detail: 'origin/feat' })
        const rgit = (...a: string[]): string => execFileSync('git', ['-C', remote, ...a], { encoding: 'utf8' }).trim()
        expect(rgit('log', '-1', '--format=%s', 'feat')).toBe('Feat')
        expect(rgit('log', '-1', '--format=%s', 'main')).toBe('init')
        expect(await branchSync(r)).toMatchObject({ upstream: 'origin/feat', ahead: 0 })
      }
    },
    TIMEOUT
  )

  maybe(
    'makes ssh fail instead of prompting, unless the user set their own ssh command',
    async () => {
      const r = repo()
      if (!process.env.GIT_SSH_COMMAND && !process.env.GIT_SSH) {
        expect((await pushEnv(r)).GIT_SSH_COMMAND).toBe('ssh -oBatchMode=yes')
      }
      git(r, 'config', 'core.sshCommand', 'my-ssh')
      expect((await pushEnv(r)).GIT_SSH_COMMAND).toBe(process.env.GIT_SSH_COMMAND)
    },
    TIMEOUT
  )
})

function fakeProvider(text: string): Provider {
  return {
    async *streamChat(): AsyncGenerator<ProviderStreamEvent> {
      yield { type: 'text', text } as ProviderStreamEvent
    }
  } as unknown as Provider
}

describe('suggestCommitMessage', () => {
  it('builds a clipped request and tidies the reply', () => {
    const req = commitMessageRequest('x'.repeat(20_000))
    expect(req[0].content.length).toBeLessThan(13_000)
    expect(req[0].content).toMatch(/diff shortened/)
    expect(sanitizeCommitMessage('```\nFix the thing\n```')).toBe('Fix the thing')
    expect(sanitizeCommitMessage('Commit message: "Add x"')).toBe('Add x')
    expect(sanitizeCommitMessage('  ')).toBeNull()
  })

  maybe(
    'asks the model with the diff and returns its message',
    async () => {
      const r = repo()
      writeFileSync(join(r, 'a.txt'), 'two\n')
      let seen = ''
      const provider = {
        async *streamChat(req: { messages: { content: string }[] }): AsyncGenerator<ProviderStreamEvent> {
          seen = req.messages[0].content
          yield { type: 'text', text: 'Change a to two' } as ProviderStreamEvent
        }
      } as unknown as Provider
      expect(await suggestCommitMessage(r, null, deps([r]), () => provider)).toEqual({ ok: true, detail: 'Change a to two' })
      expect(seen).toMatch(/\+two/)
    },
    TIMEOUT
  )

  maybe(
    'says why when there is nothing to describe or no model',
    async () => {
      const r = repo()
      expect(await suggestCommitMessage(r, null, deps([r]), () => fakeProvider('x'))).toMatchObject({ ok: false, error: /no changes/ })
      writeFileSync(join(r, 'a.txt'), 'two\n')
      expect(await suggestCommitMessage(r, null, deps([r]), () => null)).toMatchObject({ ok: false })
      host.selected = null
      expect(await suggestCommitMessage(r, null, deps([r]), () => fakeProvider('x'))).toMatchObject({ ok: false, error: /model/ })
      host.selected = { providerId: 'p', model: 'm' }
    },
    TIMEOUT
  )
})

describe('lookupPr', () => {
  const view = JSON.stringify({ number: 7, title: 'T', state: 'OPEN', isDraft: true, url: 'https://github.com/o/r/pull/7', statusCheckRollup: [] })

  maybe(
    'reads the branch PR through gh with the repository pinned',
    async () => {
      const r = repo()
      git(r, 'checkout', '-qb', 'feature')
      const calls: { args: string[]; env?: NodeJS.ProcessEnv }[] = []
      const gh = () => async (args: string[], _cwd: string, _s?: AbortSignal, env?: NodeJS.ProcessEnv) => {
        calls.push({ args, env })
        return { ok: true, stdout: view, stderr: '', code: 0 }
      }
      const res = await lookupPr(r, { ...deps([r]), gh, authedHosts: async () => ['github.com'], repoKey: async () => 'github.com:o/r' })
      expect(res).toMatchObject({ kind: 'pr', pr: { number: 7, isDraft: true, checks: 'none' } })
      expect(calls[0].args.slice(0, 3)).toEqual(['pr', 'view', 'feature'])
      expect(calls[0].env).toEqual({ GH_REPO: 'github.com/o/r' })
    },
    TIMEOUT
  )

  maybe(
    'is unavailable without gh, sign-in or a GitHub remote, and none when the branch has no PR',
    async () => {
      const r = repo()
      const none = () => async () => ({ ok: false, stdout: '', stderr: 'no pull requests found for branch "main"', code: 1 })
      const base = { ...deps([r]), authedHosts: async () => ['github.com'], repoKey: async () => 'o/r' }
      expect(await lookupPr(r, { ...base, gh: () => null })).toEqual({ kind: 'unavailable' })
      expect(await lookupPr(r, { ...base, gh: none, authedHosts: async () => [] })).toEqual({ kind: 'unavailable' })
      expect(await lookupPr(r, { ...base, gh: none, repoKey: async () => null })).toEqual({ kind: 'unavailable' })
      expect(await lookupPr(r, { ...base, gh: none })).toEqual({ kind: 'none' })
      expect(await lookupPr(r, { ...deps([]), gh: none })).toEqual({ kind: 'unavailable' })
    },
    TIMEOUT
  )
})
