import { afterEach, describe, it, expect } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  filterProbeFailed,
  GIT_HARDENING,
  hardenedGitArgs,
  localFilterOverrides,
  runGitCapture,
  scopedConfig,
  showScopeUnsupported,
  uncommittedDiffBase,
  withScope,
  type ConfigProbe,
  type ConfigRunner,
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

describe('git older than 2.26 (no --show-scope)', () => {
  const tooOld: ConfigProbe = {
    err: Object.assign(new Error('Command failed'), { code: 129 }),
    stdout: '',
    stderr: "error: unknown option `show-scope'\nusage: git config [<options>]\n"
  }

  it('recognises git refusing --show-scope, and nothing else', () => {
    expect(showScopeUnsupported(tooOld)).toBe(true)
    expect(showScopeUnsupported({ ...tooOld, stderr: "error: unknown option `show-origin'" })).toBe(false)
    expect(showScopeUnsupported({ ...tooOld, err: Object.assign(new Error('x'), { code: 128 }) })).toBe(false)
    expect(showScopeUnsupported({ err: null, stdout: '', stderr: '' })).toBe(false)
  })

  it('labels unscoped -z records with a scope, keeping keys without a value', () => {
    expect(withScope('local', 'filter.a.clean\ncat\0filter.b.required\0')).toBe(
      'local\0filter.a.clean\ncat\0local\0filter.b.required\0'
    )
    expect(withScope('local', '')).toBe('')
  })

  /** A runner answering from a map keyed by the joined args; anything else fails like git. */
  const scripted =
    (answers: Record<string, Partial<ConfigProbe>>, calls: string[] = []): ConfigRunner =>
    async (args) => {
      const key = args.join(' ')
      calls.push(key)
      if (key.startsWith('--show-scope')) return tooOld
      const a = answers[key]
      if (!a) return { err: Object.assign(new Error('no answer'), { code: 2 }), stdout: '', stderr: `no answer for ${key}` }
      return { err: null, stdout: '', stderr: '', ...a }
    }
  const noMatch = { err: Object.assign(new Error('exit 1'), { code: 1 }) }

  it("lists only the repository's own files, as local and worktree records", async () => {
    const calls: string[] = []
    const r = await scopedConfig(
      '/r',
      ['--get-regexp', '^filter\\.'],
      scripted(
        {
          "--local --includes -z --get-regexp ^filter\\.": { stdout: 'filter.evil.clean\ntouch x\0' },
          '--local --bool --get extensions.worktreeConfig': { stdout: 'true\n' },
          "--worktree --includes -z --get-regexp ^filter\\.": { stdout: 'filter.wt.smudge\ncat\0' }
        },
        calls
      )
    )
    expect(r).toEqual({ err: null, stdout: 'local\0filter.evil.clean\ntouch x\0worktree\0filter.wt.smudge\ncat\0', stderr: '' })
    expect(calls[0]).toBe('--show-scope -z --get-regexp ^filter\\.')
  })

  it('skips per-worktree config when the repository does not turn it on', async () => {
    const calls: string[] = []
    const r = await scopedConfig(
      '/r',
      ['--list'],
      scripted({ '--local --includes -z --list': { stdout: 'core.bare\nfalse\0' }, '--local --bool --get extensions.worktreeConfig': noMatch }, calls)
    )
    expect(r.stdout).toBe('local\0core.bare\nfalse\0')
    expect(calls.some((c) => c.startsWith('--worktree'))).toBe(false)
  })

  it('reads outside a repository as no entries, and hands back any other failure to refuse on', async () => {
    const outside = scripted({
      '--local --includes -z --list': {
        err: Object.assign(new Error('x'), { code: 128 }),
        stderr: 'fatal: --local can only be used inside a git repository\n'
      }
    })
    expect(await scopedConfig('/tmp', ['--list'], outside)).toEqual({ err: null, stdout: '', stderr: '' })
    const cutOff = scripted({
      '--local --includes -z --list': { err: Object.assign(new Error('maxBuffer'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), stdout: 'local' }
    })
    expect((await scopedConfig('/r', ['--list'], cutOff)).err).not.toBeNull()
    await expect(hardenedGitArgs('/r', scripted({ "--local --includes -z --get-regexp ^filter\\.": { err: Object.assign(new Error('t'), { killed: true, signal: 'SIGTERM' }) } }))).rejects.toThrow(
      /could not read this repository's git config/
    )
  })

  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const posix = gitOk && process.platform !== 'win32' ? it : it.skip

  posix(
    'blanks the same drivers as a git with --show-scope: the repo\'s and its includes\', never the user\'s',
    async () => {
      const base = realpathSync(mkdtempSync(join(tmpdir(), 'houston-oldgit-')))
      dirs.push(base)
      const r = join(base, 'repo')
      const globalCfg = join(base, 'global.gitconfig')
      writeFileSync(globalCfg, '[filter "lfs"]\n\tclean = git-lfs clean -- %f\n')
      const env = { ...process.env, GIT_CONFIG_GLOBAL: globalCfg, GIT_CONFIG_NOSYSTEM: '1' }
      execFileSync('git', ['init', '-q', r], { env })
      writeFileSync(join(base, 'included.cfg'), '[filter "inc"]\n\tclean = touch inc-ran\n')
      appendFileSync(join(r, '.git', 'config'), `[filter "evil"]\n\tclean = touch evil-ran\n[include]\n\tpath = ${join(base, 'included.cfg')}\n`)
      /** Real git; `old` rejects --show-scope the way git 2.25 does. */
      const realGit =
        (old: boolean): ConfigRunner =>
        (args, cwd) =>
          old && args.includes('--show-scope')
            ? Promise.resolve(tooOld)
            : new Promise((resolve) =>
                execFile('git', ['config', ...args], { cwd, env }, (err, stdout, stderr) =>
                  resolve({ err: err as ConfigProbe['err'], stdout: String(stdout), stderr: String(stderr) })
                )
              )
      const blanked = (args: string[]): string[] => args.filter((a) => a.endsWith('.clean=')).sort()
      const modern = await hardenedGitArgs(r, realGit(false))
      const old = await hardenedGitArgs(r, realGit(true))
      expect(blanked(old)).toEqual(['filter.evil.clean=', 'filter.inc.clean='])
      expect(old).toEqual(modern)
      // Outside any repository: only the fixed flags, as before.
      const outside = join(base, 'plain')
      execFileSync('mkdir', [outside])
      const outsideEnv = { ...env, GIT_CEILING_DIRECTORIES: base }
      const plainGit: ConfigRunner = (args, cwd) =>
        args.includes('--show-scope')
          ? Promise.resolve(tooOld)
          : new Promise((resolve) =>
              execFile('git', ['config', ...args], { cwd, env: outsideEnv }, (err, stdout, stderr) =>
                resolve({ err: err as ConfigProbe['err'], stdout: String(stdout), stderr: String(stderr) })
              )
            )
      expect(await hardenedGitArgs(outside, plainGit)).toEqual(GIT_HARDENING)
    },
    30_000
  )
})
