import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  answerKeeps,
  describeChange,
  diffRepo,
  GIT_GUARD_KEEP,
  GIT_GUARD_UNDO,
  GitGuard,
  gitGuardQuestion,
  isExecConfigEntry,
  isKnownHooksPath,
  manualUndo,
  parseConfigList,
  reviewGitChanges,
  type GitChange,
  type RepoSnap
} from './gitGuard'

describe('isExecConfigEntry', () => {
  it('flags keys that make git run a command', () => {
    for (const key of [
      'core.fsmonitor',
      'core.hooksPath',
      'core.sshCommand',
      'core.pager',
      'diff.external',
      'diff.pdf.textconv',
      'merge.ours.driver',
      'filter.lfs.clean',
      'filter.x.process',
      'gpg.program',
      'gpg.ssh.program',
      'credential.helper',
      'credential.https://example.com.helper',
      'alias.st',
      'include.path',
      'includeIf.gitdir:~/work/.path',
      'pager.log',
      'remote.origin.uploadpack',
      'protocol.ext.allow',
      'uploadpack.packObjectsHook'
    ]) {
      expect(isExecConfigEntry(key, 'evil'), key).toBe(true)
    }
  })

  it('leaves settings that run nothing alone', () => {
    for (const key of [
      'user.email',
      'user.name',
      'remote.origin.url',
      'remote.origin.fetch',
      'branch.main.remote',
      'branch.main.merge',
      'core.bare',
      'core.repositoryformatversion',
      'extensions.worktreeConfig',
      'submodule.lib.url',
      'filter.lfs.required'
    ]) {
      expect(isExecConfigEntry(key, 'x'), key).toBe(false)
    }
  })

  it('treats a boolean fsmonitor (the built-in daemon) as running nothing', () => {
    expect(isExecConfigEntry('core.fsmonitor', 'true')).toBe(false)
    expect(isExecConfigEntry('core.fsmonitor', 'false')).toBe(false)
    expect(isExecConfigEntry('core.fsmonitor', '')).toBe(false)
    expect(isExecConfigEntry('core.fsmonitor', '.git/hooks/query-watchman')).toBe(true)
  })

  it('flags only a !command submodule update mode', () => {
    expect(isExecConfigEntry('submodule.lib.update', 'rebase')).toBe(false)
    expect(isExecConfigEntry('submodule.lib.update', '!sh -c evil')).toBe(true)
  })
})

describe('isKnownHooksPath', () => {
  it('recognizes husky folders in their usual spellings', () => {
    expect(isKnownHooksPath('.husky')).toBe(true)
    expect(isKnownHooksPath('.husky/_')).toBe(true)
    expect(isKnownHooksPath('./.husky/_/')).toBe(true)
  })

  it('does not recognize anything else', () => {
    expect(isKnownHooksPath('.git/hooks2')).toBe(false)
    expect(isKnownHooksPath('/tmp/hooks')).toBe(false)
    expect(isKnownHooksPath('.husky/../evil')).toBe(false)
  })
})

describe('parseConfigList', () => {
  it('splits key and value records, keeping newlines inside values', () => {
    expect(parseConfigList('core.bare\nfalse\0alias.x\n!a\nb\0core.flag\0')).toEqual([
      ['core.bare', 'false'],
      ['alias.x', '!a\nb'],
      ['core.flag', '']
    ])
  })
})

describe('describeChange / manualUndo / question', () => {
  const ws = '/w'
  const cfg: GitChange = {
    kind: 'config',
    repo: ws,
    file: '/w/.git/config',
    key: 'core.fsmonitor',
    before: [],
    after: ['sh evil.sh'],
    known: false
  }

  it('names the file, key, and value', () => {
    expect(describeChange(cfg, ws)).toBe('.git/config: core.fsmonitor set to "sh evil.sh"')
    expect(manualUndo(cfg)).toBe("git config --file '/w/.git/config' --unset-all 'core.fsmonitor'")
  })

  it('quotes a path with a single quote safely', () => {
    const hook: GitChange = {
      kind: 'hook',
      repo: ws,
      file: "/w/.git/hooks/it's",
      after: { hash: 'h', mode: 0o755 }
    }
    expect(manualUndo(hook)).toBe(`rm '/w/.git/hooks/it'\\''s'`)
  })

  it('asks with an undo option first, and only an answer starting with keep keeps', () => {
    const q = gitGuardQuestion([cfg], ws)
    expect(q.options.map((o) => o.label)).toEqual([GIT_GUARD_UNDO, GIT_GUARD_KEEP])
    expect(q.question).toContain('core.fsmonitor')
    expect(q.question).not.toContain('—')
    expect(answerKeeps(GIT_GUARD_KEEP)).toBe(true)
    expect(answerKeeps('keep, I installed lefthook')).toBe(true)
    expect(answerKeeps(GIT_GUARD_UNDO)).toBe(false)
    expect(answerKeeps('')).toBe(false)
    expect(answerKeeps('what is this?')).toBe(false)
  })
})

describe('diffRepo', () => {
  const base = (over: Partial<RepoSnap> = {}): RepoSnap => ({
    dir: '/w',
    dotGit: { kind: 'dir' },
    gitDir: '/w/.git',
    commonDir: '/w/.git',
    commondirs: new Map([['/w/.git/commondir', null]]),
    configs: new Map(),
    hooks: new Map(),
    hooksDir: '/w/.git/hooks',
    ...over
  })

  it('reports nothing for identical snapshots', () => {
    expect(diffRepo(base(), base())).toEqual([])
  })

  it('does not report a deleted hook (it runs nothing)', () => {
    const before = base({ hooks: new Map([['pre-commit', { hash: 'a', mode: 0o755 }]]) })
    expect(diffRepo(before, base())).toEqual([])
  })

  it('reports a mode-only hook change (made executable)', () => {
    const before = base({ hooks: new Map([['pre-commit', { hash: 'a', mode: 0o644 }]]) })
    const after = base({ hooks: new Map([['pre-commit', { hash: 'a', mode: 0o755 }]]) })
    expect(diffRepo(before, after).map((c) => c.kind)).toEqual(['hook'])
  })

  it('reports everything exec-capable in a repository first seen now', () => {
    const after = base({
      configs: new Map([['/w/.git/config', { text: 'x', exec: new Map([['core.fsmonitor', ['evil']]]) }]])
    })
    expect(diffRepo(undefined, after)).toMatchObject([{ kind: 'config', key: 'core.fsmonitor', before: [] }])
  })
})

// ---- Real repositories ------------------------------------------------------------

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  })

function makeRepo(dir: string): void {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q')
  writeFileSync(join(dir, 'a.txt'), 'a\n')
  git(dir, 'add', 'a.txt')
  git(dir, 'commit', '-qm', 'init')
}

const posix = process.platform !== 'win32'

describe('GitGuard on real repositories', () => {
  let tmp: string
  let ws: string

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'houston-gitguard-')))
    ws = join(tmp, 'ws')
    makeRepo(ws)
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  async function guarded(): Promise<GitGuard> {
    const guard = new GitGuard([ws])
    await guard.ensureBaseline()
    return guard
  }

  it('ignores ordinary git work: commits, user config, remotes, upstreams', async () => {
    const guard = await guarded()
    git(tmp, 'init', '-q', '--bare', 'remote.git')
    git(ws, 'config', 'user.email', 'x@y')
    git(ws, 'remote', 'add', 'origin', '../remote.git')
    git(ws, 'push', '-q', '-u', 'origin', 'main')
    writeFileSync(join(ws, 'b.txt'), 'b\n')
    git(ws, 'add', 'b.txt')
    git(ws, 'commit', '-qm', 'b')
    expect((await guard.check()).changes).toEqual([])
  })

  it('ignores a sample hook and settings already present at the baseline', async () => {
    git(ws, 'config', 'alias.st', 'status')
    const guard = await guarded()
    writeFileSync(join(ws, '.git/hooks/pre-commit.sample'), '#!/bin/sh\n')
    expect((await guard.check()).changes).toEqual([])
  })

  it('catches a planted fsmonitor and undoes only it, keeping unrelated config changes', async () => {
    const guard = await guarded()
    git(ws, 'config', 'core.fsmonitor', 'sh -c evil')
    git(ws, 'config', 'user.email', 'kept@x')
    const { changes } = await guard.check()
    expect(changes).toMatchObject([{ kind: 'config', key: 'core.fsmonitor', after: ['sh -c evil'] }])
    expect(await guard.undo(changes)).toEqual([])
    expect(git(ws, 'config', '--file', '.git/config', '--get', 'user.email').trim()).toBe('kept@x')
    expect(() => git(ws, 'config', '--get', 'core.fsmonitor')).toThrow()
    expect((await guard.check()).changes).toEqual([])
  })

  it('restores a changed exec-capable value to what it was', async () => {
    git(ws, 'config', 'alias.lg', 'log --oneline')
    const guard = await guarded()
    git(ws, 'config', 'alias.lg', '!sh -c evil')
    const { changes } = await guard.check()
    expect(changes).toMatchObject([{ key: 'alias.lg', before: ['log --oneline'] }])
    await guard.undo(changes)
    expect(git(ws, 'config', '--get', 'alias.lg').trim()).toBe('log --oneline')
  })

  it('catches a new hook and removes it on undo', async () => {
    const guard = await guarded()
    const hook = join(ws, '.git/hooks/pre-commit')
    writeFileSync(hook, '#!/bin/sh\necho evil\n')
    chmodSync(hook, 0o755)
    const { changes } = await guard.check()
    expect(changes).toMatchObject([{ kind: 'hook', file: hook }])
    expect(describeChange(changes[0]!, ws)).toContain('new hook .git/hooks/pre-commit')
    await guard.undo(changes)
    expect(existsSync(hook)).toBe(false)
  })

  it('puts a changed hook back with its old bytes and mode', async () => {
    const hook = join(ws, '.git/hooks/pre-push')
    writeFileSync(hook, '#!/bin/sh\necho mine\n')
    chmodSync(hook, 0o755)
    const guard = await guarded()
    writeFileSync(hook, '#!/bin/sh\necho evil\n')
    chmodSync(hook, 0o777)
    const { changes } = await guard.check()
    expect(changes).toHaveLength(1)
    await guard.undo(changes)
    expect(readFileSync(hook, 'utf8')).toBe('#!/bin/sh\necho mine\n')
    if (posix) expect(statSync(hook).mode & 0o777).toBe(0o755)
  })

  it('catches a commondir redirect and removes it on undo', async () => {
    const guard = await guarded()
    const file = join(ws, '.git/commondir')
    writeFileSync(file, '../evil\n')
    const { changes } = await guard.check()
    expect(changes).toMatchObject([{ kind: 'commondir', file, before: null }])
    await guard.undo(changes)
    expect(existsSync(file)).toBe(false)
  })

  it('follows one level of include.path into the included file', async () => {
    writeFileSync(join(ws, 'extra.cfg'), '[user]\n\tname = x\n')
    git(ws, 'config', 'include.path', '../extra.cfg')
    const guard = await guarded()
    writeFileSync(join(ws, 'extra.cfg'), '[core]\n\tfsmonitor = sh -c evil\n')
    const { changes } = await guard.check()
    expect(changes).toMatchObject([{ kind: 'config', file: join(ws, 'extra.cfg'), key: 'core.fsmonitor' }])
  })

  it('catches a nested repository recorded as a submodule entry, and its undo stops git status running it', async () => {
    const guard = await guarded()
    const nested = join(ws, 'x')
    makeRepo(nested)
    const log = join(tmp, 'ran.log')
    git(nested, 'config', 'core.fsmonitor', `echo ran >> '${log}'; false`)
    const oid = git(nested, 'rev-parse', 'HEAD').trim()
    git(ws, 'update-index', '--add', '--cacheinfo', `160000,${oid},x`)

    const status = (): void => {
      execFileSync('git', ['status', '--short'], { cwd: ws, stdio: 'ignore' })
    }
    // The threat itself: the root's plain `git status` runs the nested repo's fsmonitor.
    if (posix) {
      status()
      expect(existsSync(log)).toBe(true)
      rmSync(log)
    }

    const { changes } = await guard.check()
    expect(changes).toMatchObject([{ kind: 'config', repo: nested, key: 'core.fsmonitor' }])
    await guard.undo(changes)
    if (posix) {
      status()
      expect(existsSync(log)).toBe(false)
    }
  })

  it('in a linked worktree, watches the shared config and the other worktrees’ redirects', async () => {
    const wt = join(tmp, 'wt')
    git(ws, 'worktree', 'add', '-q', wt)
    git(ws, 'worktree', 'add', '-q', join(tmp, 'other'))
    const guard = new GitGuard([wt])
    await guard.ensureBaseline()

    git(wt, 'config', 'core.fsmonitor', 'sh -c evil')
    const otherCommondir = join(ws, '.git/worktrees/other/commondir')
    writeFileSync(otherCommondir, '../../../evil\n')
    const { changes } = await guard.check()
    expect(changes.map((c) => c.kind).sort()).toEqual(['commondir', 'config'])
    await guard.undo(changes)
    expect(readFileSync(otherCommondir, 'utf8')).toBe('../..\n')
    expect(() => git(ws, 'config', '--get', 'core.fsmonitor')).toThrow()
  })

  it('catches a repointed .git file and restores the pointer', async () => {
    const wt = join(tmp, 'wt')
    git(ws, 'worktree', 'add', '-q', wt)
    const guard = new GitGuard([wt])
    await guard.ensureBaseline()
    const pointer = readFileSync(join(wt, '.git'), 'utf8')
    mkdirSync(join(wt, 'fake'))
    writeFileSync(join(wt, '.git'), 'gitdir: fake\n')
    const { changes } = await guard.check()
    expect(changes.some((c) => c.kind === 'dotgit')).toBe(true)
    await guard.undo(changes)
    expect(readFileSync(join(wt, '.git'), 'utf8')).toBe(pointer)
  })

  // Symlinks need privileges on Windows.
  describe.skipIf(!posix)('undo never writes outside the repository', () => {
    it('removes a hook swapped for a symlink instead of writing through it', async () => {
      const hook = join(ws, '.git/hooks/pre-commit')
      writeFileSync(hook, '#!/bin/sh\necho mine\n')
      chmodSync(hook, 0o755)
      const guard = await guarded()
      const victim = join(tmp, 'victim.rc')
      writeFileSync(victim, 'precious\n')
      rmSync(hook)
      symlinkSync(victim, hook)
      const { changes } = await guard.check()
      expect(await guard.undo(changes)).toEqual([])
      expect(readFileSync(victim, 'utf8')).toBe('precious\n')
      expect(lstatSync(hook).isSymbolicLink()).toBe(false)
      expect(readFileSync(hook, 'utf8')).toBe('#!/bin/sh\necho mine\n')
    })

    it('puts back a config swapped for a symlink without editing its target', async () => {
      const guard = await guarded()
      const before = readFileSync(join(ws, '.git/config'), 'utf8')
      const victim = join(tmp, 'global.gitconfig')
      writeFileSync(victim, '[alias]\n\tco = checkout\n[core]\n\trepositoryformatversion = 0\n')
      rmSync(join(ws, '.git/config'))
      symlinkSync(victim, join(ws, '.git/config'))
      const { changes } = await guard.check()
      expect(changes).toMatchObject([{ kind: 'config', key: 'alias.co' }])
      expect(await guard.undo(changes)).toEqual([])
      expect(readFileSync(victim, 'utf8')).toContain('co = checkout')
      expect(lstatSync(join(ws, '.git/config')).isSymbolicLink()).toBe(false)
      expect(readFileSync(join(ws, '.git/config'), 'utf8')).toBe(before)
    })

    it("reports, but doesn't touch, another repository a submodule entry points at", async () => {
      const guard = await guarded()
      const other = join(tmp, 'other')
      makeRepo(other)
      git(other, 'config', 'alias.mine', '!echo mine')
      const otherHook = join(other, '.git/hooks/pre-push')
      writeFileSync(otherHook, '#!/bin/sh\necho mine\n')
      // A checkout in the workspace whose .git points at the user's other repository.
      mkdirSync(join(ws, 'x'))
      writeFileSync(join(ws, 'x/.git'), `gitdir: ${join(other, '.git')}\n`)
      const oid = git(other, 'rev-parse', 'HEAD').trim()
      git(ws, 'update-index', '--add', '--cacheinfo', `160000,${oid},x`)

      const { changes } = await guard.check()
      expect(changes.map((c) => c.kind).sort()).toEqual(['config', 'hook'])
      const failed = await guard.undo(changes)
      expect(failed).toHaveLength(2)
      expect(existsSync(otherHook)).toBe(true)
      expect(git(other, 'config', '--file', '.git/config', '--get', 'alias.mine').trim()).toBe('!echo mine')
    })
  })

  it('spawns no git when nothing changed (cached parse and index listing)', async () => {
    const readConfigEntries = vi.fn(async () => [] as Array<[string, string]>)
    const listGitlinks = vi.fn(async () => new Map<string, string>())
    const guard = new GitGuard([ws], { readConfigEntries, listGitlinks })
    await guard.ensureBaseline()
    const calls = readConfigEntries.mock.calls.length + listGitlinks.mock.calls.length
    await guard.check()
    await guard.check()
    expect(readConfigEntries.mock.calls.length + listGitlinks.mock.calls.length).toBe(calls)
  })

  describe('reviewGitChanges', () => {
    it('returns nothing and asks nothing when nothing exec-capable changed', async () => {
      const guard = await guarded()
      const ask = vi.fn()
      git(ws, 'config', 'user.name', 'n')
      expect(await reviewGitChanges(guard, { workspace: ws, ask })).toBe('')
      expect(ask).not.toHaveBeenCalled()
    })

    it("notes husky's hooksPath without asking", async () => {
      const guard = await guarded()
      const ask = vi.fn()
      git(ws, 'config', 'core.hooksPath', '.husky/_')
      const note = await reviewGitChanges(guard, { workspace: ws, ask })
      expect(note).toContain('core.hookspath')
      expect(note).toContain('known hook installer')
      expect(ask).not.toHaveBeenCalled()
      expect(git(ws, 'config', '--get', 'core.hooksPath').trim()).toBe('.husky/_')
    })

    it('keeps the change when the user says keep, and does not ask again for it', async () => {
      const guard = await guarded()
      const hook = join(ws, '.git/hooks/pre-commit')
      writeFileSync(hook, '#!/bin/sh\nlefthook run pre-commit\n')
      const ask = vi.fn(async () => GIT_GUARD_KEEP)
      const note = await reviewGitChanges(guard, { workspace: ws, ask })
      expect(ask).toHaveBeenCalledTimes(1)
      expect(note).toContain('chose to keep')
      expect(note).toContain(`rm '${hook}'`)
      expect(existsSync(hook)).toBe(true)
      expect(await reviewGitChanges(guard, { workspace: ws, ask })).toBe('')
      expect(ask).toHaveBeenCalledTimes(1)
    })

    it('undoes when the user says undo', async () => {
      const guard = await guarded()
      git(ws, 'config', 'core.fsmonitor', 'sh -c evil')
      const note = await reviewGitChanges(guard, { workspace: ws, ask: async () => GIT_GUARD_UNDO })
      expect(note).toContain('chose to undo')
      expect(() => git(ws, 'config', '--get', 'core.fsmonitor')).toThrow()
    })

    it('undoes on its own when nobody can be asked', async () => {
      const guard = await guarded()
      git(ws, 'config', 'core.fsmonitor', 'sh -c evil')
      const note = await reviewGitChanges(guard, { workspace: ws })
      expect(note).toContain('Nobody was available')
      expect(() => git(ws, 'config', '--get', 'core.fsmonitor')).toThrow()
    })
  })
})
