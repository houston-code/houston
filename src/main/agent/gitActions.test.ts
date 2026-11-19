import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Provider, ProviderStreamEvent } from '@shared/agent'
import { GIT_ENV, withScope } from './gitRead'
import { collectWorkingTreeChanges } from './workingTree'

const host = vi.hoisted(() => ({
  provider: { id: 'p', kind: 'openai-compatible', models: [{ id: 'm' }] } as unknown,
  selected: { providerId: 'p', model: 'm' } as { providerId: string; model: string } | null,
  secrets: [] as string[]
}))
vi.mock('../agentHost', () => ({
  getProvider: (id: string) => (id === 'p' ? host.provider : undefined),
  getSettings: () => ({ selected: host.selected }),
  collectSecrets: () => host.secrets
}))
vi.mock('../conversations', () => ({ peekConversation: () => null }))

import {
  branchSync,
  commitAll,
  commitMessageRequest,
  lookupPr,
  pushBranch,
  gitError,
  pushEnv,
  pushTargetProblem,
  repoFilterDrivers,
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
const posix = gitOk && process.platform !== 'win32' ? it : it.skip
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

  it('names the keys that reach past this repository or run a ref command on push', () => {
    const keys = ['core.alternateRefsCommand', 'remote.origin.vcs', 'push.recurseSubmodules', 'submodule.recurse']
    const out = [...keys.flatMap((k) => ['local', `${k}\nx`]), 'global', 'submodule.recurse\ntrue', ''].join('\0')
    expect(riskyRepoConfig(out)).toEqual(keys.map((k) => k.toLowerCase()))
  })
})

describe('repoFilterDrivers', () => {
  it('names the filter drivers the repository defines, not the user’s own', () => {
    const out = [
      'local', 'filter.vault.clean\nx',
      'local', 'filter.vault.smudge\ny',
      'global', 'filter.lfs.process\ngit-lfs filter-process',
      'worktree', 'filter.a.b.process\nz',
      'local', 'filter.c.required\ntrue',
      ''
    ].join('\0')
    expect(repoFilterDrivers(out)).toEqual(['vault', 'a.b'])
  })

  it('reads the records built on git older than 2.26 the same way', () => {
    // Without --show-scope only the repository's own files are listed, all of them untrusted.
    const out = withScope('local', 'filter.vault.clean\nx\0gpg.program\nx\0user.name\nme\0') + withScope('worktree', 'filter.wt.smudge\ny\0')
    expect(repoFilterDrivers(out)).toEqual(['vault', 'wt'])
    expect(riskyRepoConfig(out)).toEqual(['gpg.program'])
  })
})

describe('pushTargetProblem', () => {
  it('passes network remotes', () => {
    for (const url of [
      'https://github.com/o/r.git',
      'http://git.example.test/r',
      'ssh://git@github.com/o/r.git',
      'git://example.test/r.git',
      'git@github.com:o/r.git',
      'host:path/r.git',
      '[::1]:r.git',
      'codecommit::us-east-1://r',
      '  https://example.test/r\n'
    ]) {
      expect(pushTargetProblem(url), url).toBeNull()
    }
  })

  it('refuses local paths, file URLs, and the command transports', () => {
    for (const url of [
      '/tmp/r.git',
      './r.git',
      '../r.git',
      'r.git',
      '.cache/r.git',
      '~/r.git',
      'sub/dir:with-colon',
      'file:///tmp/r.git',
      'FILE://localhost/tmp/r.git',
      'C:\\Users\\me\\r.git',
      'C:/r.git',
      '\\\\server\\share\\r.git',
      'testgit::/tmp/r.git',
      'helper::file:///tmp/r'
    ]) {
      expect(pushTargetProblem(url), url).toMatch(/folder on this computer/)
    }
    expect(pushTargetProblem('ext::sh -c touch% /tmp/x')).toMatch(/ext:: transport/)
    expect(pushTargetProblem('EXT::sh')).toMatch(/ext:: transport/)
    expect(pushTargetProblem('fd::3')).toMatch(/fd:: transport/)
    expect(pushTargetProblem('')).toBe('it has no URL')
  })
})

describe('gitError', () => {
  const url = 'To https://github.com/o/r.git'
  it('names the reason a push was rejected instead of the To line', () => {
    expect(gitError(`${url}\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to 'https://github.com/o/r.git'\nhint: Updates were rejected`, 'x')).toBe(
      "The remote branch has commits you don't have; pull first."
    )
    expect(gitError(`${url}\n ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs`, 'x')).toBe(
      "The remote branch has commits you don't have; pull first."
    )
    expect(gitError(`${url}\n ! [rejected]        main -> main (stale info)\nerror: failed to push some refs`, 'x')).toMatch(/changed since you last fetched/)
    expect(gitError(`${url}\n ! [remote rejected] main -> main (protected branch hook declined)\nerror: failed to push some refs`, 'x')).toBe(
      'The remote rejected the push: protected branch hook declined'
    )
  })

  it("prefers git's error line, and never shows the To header alone", () => {
    expect(gitError(`${url}\nerror: failed to push some refs to 'x'`, 'The push failed.')).toBe("failed to push some refs to 'x'")
    expect(gitError(`${url}\n`, 'The push failed.')).toBe('The push failed.')
    expect(gitError('hint: try this\nfatal: not a git repository', 'x')).toBe('not a git repository')
    expect(gitError('nothing to commit, working tree clean', 'x')).toBe('nothing to commit, working tree clean')
    expect(gitError('', 'The commit failed.')).toBe('The commit failed.')
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
    'refuses a repository that defines its own filter driver, instead of committing unfiltered bytes',
    async () => {
      const r = repo()
      git(r, 'config', 'filter.vault.clean', "sed 's/hunter2/ENCRYPTED/'")
      git(r, 'config', 'filter.vault.required', 'true')
      writeFileSync(join(r, '.gitattributes'), 'secrets.env filter=vault\n')
      writeFileSync(join(r, 'secrets.env'), 'DB_PASSWORD=ENCRYPTED\n')
      git(r, 'add', '.')
      git(r, 'commit', '-qm', 'secrets')
      writeFileSync(join(r, 'secrets.env'), 'DB_PASSWORD=hunter2\n')
      const res = await commitAll(r, 'Rotate', deps([r]))
      expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/own git filter \(vault\)/) })
      expect(git(r, 'rev-list', '--count', 'HEAD')).toBe('2')
      expect(git(r, 'show', 'HEAD:secrets.env')).toBe('DB_PASSWORD=ENCRYPTED')
    },
    TIMEOUT
  )

  posix(
    'refuses when the repository config is too large to list, so a planted signing program never runs',
    async () => {
      const r = repo()
      writeFileSync(join(r, 'a.txt'), 'two\n')
      const marker = join(r, 'gpg-ran')
      const prog = join(r, 'evil.sh')
      writeFileSync(prog, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`)
      chmodSync(prog, 0o755)
      appendFileSync(join(r, '.git', 'config'), `[pad]\n\tx = ${'A'.repeat(17_000_000)}\n[gpg]\n\tprogram = ${prog}\n[commit]\n\tgpgsign = true\n`)
      const res = await commitAll(r, 'x', deps([r]))
      expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/Could not read this repository's git config/) })
      expect(existsSync(marker)).toBe(false)
      expect(git(r, 'rev-list', '--count', 'HEAD')).toBe('1')
    },
    60_000
  )

  maybe(
    'in a project folder below the repository root, commits only the changes under it',
    async () => {
      const r = repo()
      mkdirSync(join(r, 'sub'))
      mkdirSync(join(r, 'other'))
      writeFileSync(join(r, 'sub', 's.txt'), 's\n')
      writeFileSync(join(r, 'other', 'o.txt'), 'o\n')
      writeFileSync(join(r, 'other', 'staged.txt'), 'x\n')
      git(r, 'add', '.')
      git(r, 'commit', '-qm', 'layout')
      writeFileSync(join(r, 'sub', 's.txt'), 's2\n')
      writeFileSync(join(r, 'sub', 'new.txt'), 'n\n')
      writeFileSync(join(r, 'other', 'o.txt'), 'o2\n')
      writeFileSync(join(r, 'other', 'secret-notes.txt'), 'private\n')
      writeFileSync(join(r, 'other', 'staged.txt'), 'y\n')
      git(r, 'add', 'other/staged.txt')
      const sub = join(r, 'sub')
      // What the Changes list (and /commit's confirmation) shows is what gets committed.
      expect((await collectWorkingTreeChanges(sub)).files.map((f) => f.path).sort()).toEqual(['new.txt', 's.txt'])
      expect(await commitAll(sub, 'Sub only', deps([sub]))).toMatchObject({ ok: true })
      expect(git(r, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual(['sub/new.txt', 'sub/s.txt'])
      // Everything outside the folder is as it was, the user's own staging included.
      expect(git(r, 'diff', '--cached', '--name-only')).toBe('other/staged.txt')
      expect(git(r, 'diff', '--name-only')).toBe('other/o.txt')
      expect(git(r, 'ls-files', '--others', '--exclude-standard')).toBe('other/secret-notes.txt')
    },
    TIMEOUT
  )

  maybe(
    'keeps message lines that start with #, as git commit -m does',
    async () => {
      const r = repo()
      writeFileSync(join(r, 'a.txt'), 'two\n')
      expect(await commitAll(r, '#123 Fix the login redirect', deps([r]))).toMatchObject({ ok: true })
      expect(git(r, 'log', '-1', '--format=%B')).toBe('#123 Fix the login redirect')
      writeFileSync(join(r, 'a.txt'), 'three\n')
      expect(await commitAll(r, 'Fix the login redirect\n\n#123', deps([r]))).toMatchObject({ ok: true })
      expect(git(r, 'log', '-1', '--format=%B')).toBe('Fix the login redirect\n\n#123')
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

/**
 * Push to a bare repository over "ssh" with no network: an ssh command that runs the
 * remote half (`git-receive-pack '<path>'`) right here instead of on a host. A push to
 * a local path is refused, so this is how the tests reach a remote at all. POSIX only:
 * the stand-in is a shell one-liner.
 */
async function withFakeSsh<T>(fn: () => Promise<T>): Promise<T> {
  const saved = { GIT_SSH_COMMAND: env.GIT_SSH_COMMAND, GIT_SSH_VARIANT: env.GIT_SSH_VARIANT }
  // Called as `<cmd> <host> "git-receive-pack '<path>'"` (the simple variant adds no options).
  env.GIT_SSH_COMMAND = `sh -c 'eval "git \${2#git-}"' fake-ssh`
  env.GIT_SSH_VARIANT = 'simple'
  try {
    return await fn()
  } finally {
    restoreEnv(saved)
  }
}

/** The environment the module under test runs git with, which the helpers here edit. */
const env = GIT_ENV as Record<string, string | undefined>

/** Put GIT_ENV's keys back the way {@link withFakeSsh} or a test found them. */
function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete env[k]
    else env[k] = v
  }
}

/** Run `fn` with the user's global git config read from a file holding `text`. */
async function withGlobalConfig<T>(text: string, fn: () => Promise<T>): Promise<T> {
  const file = join(tmp('ga-home-'), 'gitconfig')
  writeFileSync(file, text)
  const saved = { GIT_CONFIG_GLOBAL: env.GIT_CONFIG_GLOBAL }
  env.GIT_CONFIG_GLOBAL = file
  try {
    return await fn()
  } finally {
    restoreEnv(saved)
  }
}

const sshUrl = (path: string): string => `ssh://fake-host${path}`
const refsOf = (bare: string): string => execFileSync('git', ['-C', bare, 'for-each-ref'], { encoding: 'utf8' })

describe('pushBranch and branchSync', () => {
  posix(
    'publishes a branch on its first push, then pushes new commits to its upstream',
    async () => {
      const remote = tmp('ga-remote-')
      execFileSync('git', ['init', '-q', '--bare', remote])
      const r = repo()
      git(r, 'remote', 'add', 'origin', sshUrl(remote))
      expect(await branchSync(r)).toEqual({ branch: 'main', upstream: null, ahead: 1, remote: 'origin' })
      await withFakeSsh(async () => {
        expect(await pushBranch(r, deps([r]))).toEqual({ ok: true, detail: 'origin/main' })
        expect(await branchSync(r)).toMatchObject({ upstream: 'origin/main', ahead: 0 })
        writeFileSync(join(r, 'a.txt'), 'two\n')
        await commitAll(r, 'Two', deps([r]))
        expect(await branchSync(r)).toMatchObject({ ahead: 1 })
        expect(await pushBranch(r, deps([r]))).toEqual({ ok: true, detail: 'origin/main' })
      })
      expect(execFileSync('git', ['-C', remote, 'log', '-1', '--format=%s', 'main'], { encoding: 'utf8' }).trim()).toBe('Two')
    },
    TIMEOUT
  )

  posix(
    'says a push was rejected because the remote has new commits, not just "To <url>"',
    async () => {
      const remote = tmp('ga-remote-')
      execFileSync('git', ['init', '-q', '--bare', remote])
      const r = repo()
      git(r, 'remote', 'add', 'origin', sshUrl(remote))
      await withFakeSsh(async () => {
        expect(await pushBranch(r, deps([r]))).toEqual({ ok: true, detail: 'origin/main' })
      })
      // Someone else pushes first.
      const other = tmp('ga-other-')
      execFileSync('git', ['clone', '-q', '-b', 'main', remote, other])
      writeFileSync(join(other, 'theirs.txt'), 'theirs\n')
      git(other, 'add', 'theirs.txt')
      git(other, '-c', 'user.email=t@t.t', '-c', 'user.name=Test', 'commit', '-qm', 'Theirs')
      git(other, 'push', '-q', 'origin', 'main')
      writeFileSync(join(r, 'a.txt'), 'mine\n')
      await commitAll(r, 'Mine', deps([r]))
      const res = await withFakeSsh(() => pushBranch(r, deps([r])))
      expect(res).toEqual({ ok: false, error: "The remote branch has commits you don't have; pull first." })
    },
    TIMEOUT
  )

  maybe(
    'counts only the commits a first push would send for a branch with no upstream',
    async () => {
      const remote = tmp('ga-remote-')
      execFileSync('git', ['init', '-q', '--bare', remote])
      const r = repo()
      for (const n of ['two', 'three']) {
        writeFileSync(join(r, 'a.txt'), `${n}\n`)
        git(r, 'commit', '-qam', n)
      }
      git(r, 'remote', 'add', 'origin', remote)
      git(r, 'push', '-q', 'origin', 'main')
      // A new branch off the pushed main: nothing of its own yet, then one commit.
      git(r, 'switch', '-q', '-c', 'feat')
      expect(await branchSync(r)).toEqual({ branch: 'feat', upstream: null, ahead: 0, remote: 'origin' })
      writeFileSync(join(r, 'a.txt'), 'feat\n')
      git(r, 'commit', '-qam', 'Feat')
      expect(await branchSync(r)).toMatchObject({ upstream: null, ahead: 1 })
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
    'refuses a repository that uses Git LFS, whose upload hook never runs',
    async () => {
      const r = repo()
      git(r, 'remote', 'add', 'origin', 'https://example.invalid/r.git')
      mkdirSync(join(r, 'art'))
      writeFileSync(join(r, 'art', '.gitattributes'), '*.psd filter=lfs diff=lfs merge=lfs -text\n')
      git(r, 'add', '.')
      git(r, 'commit', '-qm', 'lfs')
      writeFileSync(join(r, '.git', 'hooks', 'pre-push'), '#!/bin/sh\ngit lfs pre-push "$@"\n')
      expect(await pushBranch(r, deps([r]))).toMatchObject({ ok: false, error: expect.stringMatching(/uses Git LFS/) })
      // Named only in the repository's own info/attributes.
      const r2 = repo()
      git(r2, 'remote', 'add', 'origin', 'https://example.invalid/r.git')
      mkdirSync(join(r2, '.git', 'info'), { recursive: true })
      writeFileSync(join(r2, '.git', 'info', 'attributes'), '*.bin filter=lfs\n')
      expect(await pushBranch(r2, deps([r2]))).toMatchObject({ ok: false, error: expect.stringMatching(/uses Git LFS/) })
    },
    TIMEOUT
  )

  maybe(
    'refuses a remote that is a folder on this computer, so its hooks never run',
    async () => {
      // What a sandboxed agent can build inside the workspace: a bare repository with
      // hooks, and a push URL pointing at it while the fetch URL looks normal.
      const r = repo()
      const planted = join(r, '.cache', 'r.git')
      execFileSync('git', ['init', '-q', '--bare', planted])
      const marker = join(r, 'hook-ran')
      for (const hook of ['pre-receive', 'update', 'post-receive']) {
        const file = join(planted, 'hooks', hook)
        writeFileSync(file, `#!/bin/sh\ntouch "${marker}"\n`)
        chmodSync(file, 0o755)
      }
      git(r, 'remote', 'add', 'origin', 'https://example.invalid/r.git')
      for (const pushUrl of [planted, `file://${planted}`, '.cache/r.git', `ext::sh -c touch% ${marker}`]) {
        git(r, 'remote', 'set-url', '--push', 'origin', pushUrl)
        const res = await pushBranch(r, deps([r]))
        expect(res, pushUrl).toMatchObject({ ok: false, error: expect.stringMatching(/^Houston won't push to origin: its URL /) })
        // The URL is never echoed (an https one can carry a token).
        expect((res as { error: string }).error).not.toContain(planted)
      }
      // The plain remote URL too, with no push URL.
      git(r, 'config', '--unset-all', 'remote.origin.pushurl')
      git(r, 'remote', 'set-url', 'origin', planted)
      expect(await pushBranch(r, deps([r]))).toMatchObject({ ok: false, error: /its URL is a folder on this computer/ })
      expect(existsSync(marker)).toBe(false)
      expect(refsOf(planted)).toBe('')
    },
    TIMEOUT
  )

  maybe(
    "checks the URL git really pushes to, after the user's own pushInsteadOf rewrite",
    async () => {
      const r = repo()
      const planted = tmp('ga-planted-')
      execFileSync('git', ['init', '-q', '--bare', planted])
      git(r, 'remote', 'add', 'origin', 'https://example.invalid/r.git')
      const res = await withGlobalConfig(`[url "${planted}"]\n\tpushInsteadOf = https://example.invalid/r.git\n`, () =>
        pushBranch(r, deps([r]))
      )
      expect(res).toMatchObject({ ok: false, error: /its URL is a folder on this computer/ })
      expect(refsOf(planted)).toBe('')
    },
    TIMEOUT
  )

  maybe(
    'refuses a repository that pushes its submodules or names a ref command',
    async () => {
      for (const [key, value] of [
        ['push.recurseSubmodules', 'on-demand'],
        ['submodule.recurse', 'true'],
        ['core.alternateRefsCommand', 'touch pwned'],
        ['remote.origin.vcs', 'ext']
      ]) {
        const r = repo()
        git(r, 'remote', 'add', 'origin', 'https://example.invalid/r.git')
        git(r, 'config', key, value)
        expect(await pushBranch(r, deps([r])), key).toMatchObject({ ok: false, error: expect.stringContaining(key.toLowerCase()) })
      }
    },
    TIMEOUT
  )

  posix(
    "pushes only this repository, overriding the user's own submodule push settings",
    async () => {
      const remote = tmp('ga-remote-')
      execFileSync('git', ['init', '-q', '--bare', remote])
      const r = repo()
      git(r, 'remote', 'add', 'origin', sshUrl(remote))
      // A user-level push.recurseSubmodules=check would fail this push (the gitlink
      // below has never been pushed anywhere); the Changes panel's override skips it.
      const sub = repo()
      git(r, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'sub')
      git(r, 'commit', '-qm', 'Add sub')
      // A submodule commit that exists only in this checkout, on no remote.
      writeFileSync(join(r, 'sub', 'a.txt'), 'unpushed\n')
      git(join(r, 'sub'), '-c', 'user.email=t@t.t', '-c', 'user.name=Test', 'commit', '-qam', 'Unpushed')
      git(r, 'commit', '-qam', 'Bump sub')
      // Without the override, git itself refuses this push.
      expect(() =>
        execFileSync('git', ['-C', r, '-c', 'push.recurseSubmodules=check', 'push', '-q', remote, 'HEAD:refs/heads/probe'], {
          stdio: 'ignore'
        })
      ).toThrow()
      const res = await withGlobalConfig('[push]\n\trecurseSubmodules = check\n', () =>
        withFakeSsh(() => pushBranch(r, deps([r])))
      )
      expect(res).toEqual({ ok: true, detail: 'origin/main' })
      expect(execFileSync('git', ['-C', remote, 'log', '-1', '--format=%s', 'main'], { encoding: 'utf8' }).trim()).toBe('Bump sub')
    },
    TIMEOUT
  )

  posix(
    'pushes a branch that tracks a differently named one to its own name',
    async () => {
      for (const pushDefault of ['simple', 'upstream']) {
        const remote = tmp('ga-remote-')
        execFileSync('git', ['init', '-q', '--bare', remote])
        const r = repo()
        // Set up over the local path, then point the remote at the (fake) ssh URL.
        git(r, 'remote', 'add', 'origin', remote)
        git(r, 'push', '-q', 'origin', 'main')
        git(r, 'fetch', '-q', 'origin')
        git(r, 'remote', 'set-url', 'origin', sshUrl(remote))
        git(r, 'config', 'push.default', pushDefault)
        git(r, 'switch', '-q', '-c', 'feat', 'origin/main')
        writeFileSync(join(r, 'a.txt'), 'feat\n')
        git(r, 'commit', '-qam', 'Feat')
        expect(await withFakeSsh(() => pushBranch(r, deps([r])))).toEqual({ ok: true, detail: 'origin/feat' })
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
    'leaves credential file contents and secret values out of the request',
    async () => {
      const r = repo()
      const key = `sk-${'a1B2'.repeat(12)}`
      host.secrets = ['stored-provider-secret-value']
      writeFileSync(join(r, '.env'), `OPENAI_API_KEY=${key}\nDB_HOST=localhost\n`)
      writeFileSync(join(r, 'a.txt'), `two ${key}\nstored-provider-secret-value\n`)
      let seen = ''
      const provider = {
        async *streamChat(req: { messages: { content: string }[] }): AsyncGenerator<ProviderStreamEvent> {
          seen = req.messages[0].content
          yield { type: 'text', text: 'Add config' } as ProviderStreamEvent
        }
      } as unknown as Provider
      try {
        expect(await suggestCommitMessage(r, null, deps([r]), () => provider)).toEqual({ ok: true, detail: 'Add config' })
      } finally {
        host.secrets = []
      }
      expect(seen).toContain('new file: .env')
      expect(seen).toContain('Sensitive file, contents not shown')
      expect(seen).not.toContain('DB_HOST')
      expect(seen).not.toContain(key)
      expect(seen).not.toContain('stored-provider-secret-value')
      expect(seen).toMatch(/\+two /)
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
  const view = JSON.stringify([{ number: 7, title: 'T', state: 'OPEN', isDraft: true, url: 'https://github.com/o/r/pull/7', statusCheckRollup: [] }])

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
      expect(calls[0].args).toEqual([
        'pr',
        'list',
        '--head',
        'feature',
        '--state',
        'all',
        '--limit',
        '1',
        '--json',
        'number,title,state,isDraft,url,statusCheckRollup'
      ])
      expect(calls[0].env).toEqual({ GH_REPO: 'github.com/o/r' })
    },
    TIMEOUT
  )

  maybe(
    'looks a numeric branch up as a head branch, not as a pull request number',
    async () => {
      const r = repo()
      git(r, 'checkout', '-qb', '1234')
      const calls: string[][] = []
      const gh = () => async (args: string[]) => {
        calls.push(args)
        return { ok: true, stdout: '[]', stderr: '', code: 0 }
      }
      const res = await lookupPr(r, { ...deps([r]), gh, authedHosts: async () => ['github.com'], repoKey: async () => 'github.com:o/r' })
      expect(res).toEqual({ kind: 'none' })
      expect(calls[0].slice(0, 4)).toEqual(['pr', 'list', '--head', '1234'])
      expect(calls[0]).not.toContain('view')
    },
    TIMEOUT
  )

  maybe(
    'is unavailable without gh, sign-in or a GitHub remote, and none when the branch has no PR',
    async () => {
      const r = repo()
      const none = () => async () => ({ ok: true, stdout: '[]', stderr: '', code: 0 })
      const failed = () => async () => ({ ok: false, stdout: '', stderr: 'could not connect', code: 1 })
      const base = { ...deps([r]), authedHosts: async () => ['github.com'], repoKey: async () => 'o/r' }
      expect(await lookupPr(r, { ...base, gh: () => null })).toEqual({ kind: 'unavailable' })
      expect(await lookupPr(r, { ...base, gh: none, authedHosts: async () => [] })).toEqual({ kind: 'unavailable' })
      expect(await lookupPr(r, { ...base, gh: none, repoKey: async () => null })).toEqual({ kind: 'unavailable' })
      expect(await lookupPr(r, { ...base, gh: none })).toEqual({ kind: 'none' })
      expect(await lookupPr(r, { ...base, gh: failed })).toEqual({ kind: 'unavailable' })
      expect(await lookupPr(r, { ...deps([]), gh: none })).toEqual({ kind: 'unavailable' })
    },
    TIMEOUT
  )
})
