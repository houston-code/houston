import { afterEach, describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  filterProbeFailed,
  GIT_HARDENING,
  hardenedGitArgs,
  localFilterOverrides,
  runGitCapture,
  uncommittedDiffBase,
  type GitTry
} from './gitRead'

/** A GitTry answering from a map keyed by the joined args; unknown args fail. */
const fake =
  (answers: Record<string, string>): GitTry =>
  async (args) =>
    answers[args.join(' ')] ?? null

describe('uncommittedDiffBase', () => {
  it('uses HEAD when it resolves to a commit', async () => {
    expect(await uncommittedDiffBase(fake({ 'rev-parse --verify -q HEAD^{commit}': 'abc\n' }))).toBe(
      'HEAD'
    )
  })

  it('uses the SHA-1 empty tree on an unborn HEAD', async () => {
    const base = await uncommittedDiffBase(fake({ 'rev-parse --show-object-format': 'sha1\n' }))
    expect(base).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904')
  })

  it('uses the SHA-256 empty tree in a SHA-256 repo', async () => {
    const base = await uncommittedDiffBase(fake({ 'rev-parse --show-object-format': 'sha256\n' }))
    expect(base).toBe('6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321')
  })

  it('assumes SHA-1 when git is too old to report the object format', async () => {
    expect(await uncommittedDiffBase(fake({}))).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904')
  })

  it('falls back to HEAD for an unknown object format', async () => {
    expect(await uncommittedDiffBase(fake({ 'rev-parse --show-object-format': 'sha512\n' }))).toBe('HEAD')
  })
})

describe('git hardening', () => {
  it('turns hooks and signature verification off', () => {
    expect(GIT_HARDENING).toEqual(expect.arrayContaining(['core.hooksPath=/dev/null', 'log.showSignature=false']))
  })
})

describe('localFilterOverrides', () => {
  const rec = (scope: string, key: string, value: string): string => `${scope}\0${key}\n${value}\0`

  it('blanks every filter driver the repo defines', () => {
    const out = localFilterOverrides(rec('local', 'filter.planted.clean', 'x') + rec('worktree', 'filter.wt.smudge', 'y'))
    expect(out).toEqual([
      '-c', 'filter.planted.clean=', '-c', 'filter.planted.smudge=', '-c', 'filter.planted.process=',
      '-c', 'filter.planted.required=false',
      '-c', 'filter.wt.clean=', '-c', 'filter.wt.smudge=', '-c', 'filter.wt.process=',
      '-c', 'filter.wt.required=false'
    ])
  })

  it('keeps drivers from the user\'s own config', () => {
    const out = localFilterOverrides(
      rec('global', 'filter.lfs.clean', 'git-lfs clean -- %f') + rec('system', 'filter.s.clean', 'z')
    )
    expect(out).toEqual([])
  })

  it('keeps a dotted driver name whole and lists each driver once', () => {
    const out = localFilterOverrides(rec('local', 'filter.a.b.clean', 'x') + rec('local', 'filter.a.b.smudge', 'y'))
    expect(out?.filter((a) => a.endsWith('.clean='))).toEqual(['filter.a.b.clean='])
  })

  it('refuses a driver name no -c override can name', () => {
    expect(localFilterOverrides(rec('local', 'filter.a=b.clean', 'x'))).toBeNull()
    // The same name from the user's own config is theirs to keep.
    expect(localFilterOverrides(rec('global', 'filter.a=b.clean', 'x'))).toEqual([])
  })

  it('reads an empty or truncated listing as nothing to override', () => {
    expect(localFilterOverrides('')).toEqual([])
    expect(localFilterOverrides('local')).toEqual([])
  })
})

describe('filterProbeFailed', () => {
  const err = (code: unknown, extra: Record<string, unknown> = {}): Error => Object.assign(new Error('x'), { code, ...extra })

  it('accepts a full listing, no filter keys, and a git that could not start', () => {
    expect(filterProbeFailed(null, 'local\0filter.a.clean\nx\0')).toBe(false)
    expect(filterProbeFailed(err(1), '')).toBe(false)
    expect(filterProbeFailed(err('ENOENT'), '')).toBe(false)
  })

  it('rejects a cut-off, timed-out, or failed listing', () => {
    expect(filterProbeFailed(err('ERR_CHILD_PROCESS_STDIO_MAXBUFFER'), 'local\0filter.pad.clean\nAAAA')).toBe(true)
    expect(filterProbeFailed(err(null, { killed: true, signal: 'SIGTERM' }), '')).toBe(true)
    // A git too old for --show-scope.
    expect(filterProbeFailed(err(129), '')).toBe(true)
    expect(filterProbeFailed(err(128), '')).toBe(true)
    expect(filterProbeFailed(err(1), 'local\0filter.a.clean\nx\0')).toBe(true)
  })
})

const gitOk = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

describe('hardenedGitArgs on a real repository', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const posix = gitOk && process.platform !== 'win32' ? it : it.skip

  posix(
    'refuses to run git when padding pushes a planted filter past the listing, so it never runs',
    async () => {
      const r = realpathSync(mkdtempSync(join(tmpdir(), 'houston-gitread-')))
      dirs.push(r)
      const git = (...args: string[]): string => execFileSync('git', ['-C', r, ...args], { encoding: 'utf8' })
      git('init', '-q')
      writeFileSync(join(r, 'a.txt'), 'one\n')
      git('add', 'a.txt')
      git('-c', 'user.email=t@t.t', '-c', 'user.name=T', 'commit', '-qm', 'init')
      const marker = join(r, 'filter-ran')
      appendFileSync(
        join(r, '.git', 'config'),
        `[filter "pad"]\n\tclean = ${'A'.repeat(1_200_000)}\n[filter "evil"]\n\tclean = "touch '${marker}'; cat"\n`
      )
      writeFileSync(join(r, '.gitattributes'), 'a.txt filter=evil\n')
      writeFileSync(join(r, 'a.txt'), 'two\n')
      await expect(hardenedGitArgs(r)).rejects.toThrow(/could not read this repository's git config/)
      const status = await runGitCapture(['status', '--porcelain'], r)
      expect(status.ok).toBe(false)
      expect(existsSync(marker)).toBe(false)
    },
    30_000
  )
})
