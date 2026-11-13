import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync, realpathSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { OFFLINE_FAIL_FAST_ENV, type SandboxRunOptions, type SandboxRunResult } from '../sandbox'
import { resolveWindowsBash } from '../sandbox/windows'
import {
  applySessionResult,
  buildSessionCommand,
  createShellSession,
  cwdFromRoot,
  runInSession,
  shellCwdLine,
  singleQuote,
  type ShellSession
} from './shell-session'

/** The bash the sandbox backend would use: Git for Windows' bash.exe there, else /bin/bash. */
const BASH = process.platform === 'win32' ? resolveWindowsBash() : '/bin/bash'

/** A non-sandboxed runner that executes the wrapped command with plain bash, so
 * these tests run on Linux CI (no sandbox-exec) yet exercise the real wrapper. */
function bashRunner(opts: SandboxRunOptions, env?: NodeJS.ProcessEnv): Promise<SandboxRunResult> {
  return new Promise((resolve) => {
    const child = spawn(BASH!, ['-c', opts.command], { cwd: opts.cwd, env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => (stdout += c.toString()))
    child.stderr.on('data', (c) => (stderr += c.toString()))
    child.on('close', (code) =>
      resolve({ stdout, stderr, exitCode: code, timedOut: false, sandboxed: false })
    )
  })
}

let ws: string

beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'houston-sess-')))
})
afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
})

describe('singleQuote', () => {
  it('wraps in single quotes and escapes embedded quotes', () => {
    expect(singleQuote('/a/b')).toBe(`'/a/b'`)
    expect(singleQuote(`it's`)).toBe(`'it'\\''s'`)
  })
})

describe('buildSessionCommand', () => {
  const paths = { cwdOut: '/t/c', envOut: '/t/e', envIn: '/t/i' }

  it('restores cwd, runs the command, and captures cwd + env', () => {
    const out = buildSessionCommand('make', { cwd: '/proj', env: '' }, paths)
    expect(out).toContain(`cd '/proj' 2>/dev/null`)
    expect(out).toContain('make')
    expect(out).toContain(`(pwd -W 2>/dev/null || pwd) > '/t/c'`)
    expect(out).toContain(`export -p > '/t/e'`)
    expect(out).toContain('exit $__houston_ec')
  })

  it('only sources the env file when there is captured env', () => {
    expect(buildSessionCommand('ls', { cwd: '/p', env: '' }, paths)).not.toContain('source')
    expect(buildSessionCommand('ls', { cwd: '/p', env: 'declare -x A=1' }, paths)).toContain(
      `source '/t/i' 2>/dev/null`
    )
  })

  it('captures cwd/env under a private umask so the temp files are 0600', () => {
    const out = buildSessionCommand('make', { cwd: '/proj', env: '' }, paths)
    expect(out).toContain(`(umask 077; (pwd -W 2>/dev/null || pwd) > '/t/c')`)
    expect(out).toMatch(/\(umask 077; [^\n]*export -p > '\/t\/e'\)/)
  })

  it('leaves the injected offline retry settings out of the env snapshot', () => {
    const out = buildSessionCommand('make', { cwd: '/proj', env: '' }, paths)
    const capture = out.split('\n').find((l) => l.includes(`export -p > '/t/e'`))!
    for (const [name, value] of Object.entries(OFFLINE_FAIL_FAST_ENV)) {
      expect(capture).toContain(`[ "\${${name}-}" = '${value}' ] && unset ${name};`)
    }
  })
})

describe('applySessionResult', () => {
  it('updates cwd and env from non-empty captures', () => {
    const s: ShellSession = { cwd: '/old', env: '' }
    applySessionResult(s, { cwd: '/new\n', env: 'declare -x A=1\n' })
    expect(s.cwd).toBe('/new')
    expect(s.env).toBe('declare -x A=1\n')
  })

  it('keeps previous state when captures are empty (e.g. killed command)', () => {
    const s: ShellSession = { cwd: '/old', env: 'declare -x A=1' }
    applySessionResult(s, { cwd: '', env: '' })
    expect(s).toEqual({ cwd: '/old', env: 'declare -x A=1' })
  })
})

describe('cwdFromRoot', () => {
  it('spells a directory inside the project from its root', () => {
    expect(cwdFromRoot(ws, ws)).toBe('')
    expect(cwdFromRoot(ws, join(ws, 'packages', 'api'))).toBe(join('packages', 'api'))
  })

  it('is null outside the project, including a sibling that shares its name as a prefix', () => {
    expect(cwdFromRoot(ws, dirname(ws))).toBeNull()
    expect(cwdFromRoot(ws, `${ws}-other`)).toBeNull()
  })

  it('sees through another spelling of the same directory', () => {
    // `pwd` can name the project through a symlink (or, on Windows, an 8.3 short name).
    mkdirSync(join(ws, 'real', 'sub'), { recursive: true })
    const alias = join(ws, 'alias')
    symlinkSync(join(ws, 'real'), alias, 'junction')
    expect(cwdFromRoot(join(ws, 'real'), join(alias, 'sub'))).toBe('sub')
    expect(cwdFromRoot(alias, join(ws, 'real'))).toBe('')
  })
})

describe('shellCwdLine', () => {
  const home = (): string => join(ws, 'home')

  it('says nothing while the shell is at the project root', () => {
    expect(shellCwdLine(ws, ws, home())).toBeNull()
  })

  it('names a directory inside the project from its root', () => {
    expect(shellCwdLine(ws, join(ws, 'packages', 'api'), home())).toBe(`[cwd: ${join('packages', 'api')}]`)
  })

  it('writes a directory under the home folder from ~', () => {
    expect(shellCwdLine(join(ws, 'proj'), join(home(), 'other'), home())).toBe(`[cwd: ~${sep}other]`)
    expect(shellCwdLine(join(ws, 'proj'), home(), home())).toBe('[cwd: ~]')
  })

  it('spells any other directory in full', () => {
    expect(shellCwdLine(join(ws, 'proj'), join(ws, 'elsewhere'), home())).toBe(`[cwd: ${join(ws, 'elsewhere')}]`)
    // A sibling of home whose name starts with it is not under it.
    expect(shellCwdLine(join(ws, 'proj'), `${home()}2`, home())).toBe(`[cwd: ${home()}2]`)
  })
})

// .native: on Windows plain realpathSync can keep 8.3 short names (RUNNER~1).
const canon = (p: string): string => realpathSync.native(p)

describe.skipIf(!BASH)('runInSession (end to end with real bash)', () => {
  it('persists cwd across calls', async () => {
    mkdirSync(join(ws, 'sub'))
    const session = createShellSession(ws)
    await runInSession({ command: 'cd sub', session, workspace: ws, allowNetwork: false, run: bashRunner })
    expect(canon(session.cwd)).toBe(canon(join(ws, 'sub')))

    const res = await runInSession({
      command: 'pwd -W 2>/dev/null || pwd',
      session,
      workspace: ws,
      allowNetwork: false,
      run: bashRunner
    })
    expect(canon(res.stdout.trim())).toBe(canon(join(ws, 'sub')))
  })

  it('hands the next command a cwd the OS can spawn in', async () => {
    // Git Bash's plain `pwd` prints `/c/Users/…`; used as the next spawn's cwd, that
    // fails on Windows before the command even starts. The captured cwd must be a real
    // directory path on every OS.
    mkdirSync(join(ws, 'sub'))
    const session = createShellSession(ws)
    const cwds: string[] = []
    const recording = (o: SandboxRunOptions): Promise<SandboxRunResult> => {
      cwds.push(o.cwd)
      return bashRunner(o)
    }
    await runInSession({ command: 'cd sub', session, workspace: ws, allowNetwork: false, run: recording })
    const res = await runInSession({ command: 'echo ok', session, workspace: ws, allowNetwork: false, run: recording })
    expect(res.stdout.trim()).toBe('ok')
    expect(existsSync(cwds[1])).toBe(true)
    expect(canon(cwds[1])).toBe(canon(join(ws, 'sub')))
  })

  it('persists exported environment variables across calls', async () => {
    const session = createShellSession(ws)
    await runInSession({
      command: 'export HOUSTON_TEST=hello',
      session,
      workspace: ws,
      allowNetwork: false,
      run: bashRunner
    })
    const res = await runInSession({
      command: 'echo "$HOUSTON_TEST"',
      session,
      workspace: ws,
      allowNetwork: false,
      run: bashRunner
    })
    expect(res.stdout.trim()).toBe('hello')
  })

  it('does not leak capture state into the command output', async () => {
    const session = createShellSession(ws)
    const res = await runInSession({
      command: 'echo just-this',
      session,
      workspace: ws,
      allowNetwork: false,
      run: bashRunner
    })
    expect(res.stdout.trim()).toBe('just-this')
    expect(res.stdout).not.toContain('declare -x')
  })

  it('drops the offline retry settings once the run gains network, keeping an agent export', async () => {
    // Mirrors sandboxEnv: offline launches carry OFFLINE_FAIL_FAST_ENV, networked ones don't.
    const base = { ...process.env }
    for (const name of Object.keys(OFFLINE_FAIL_FAST_ENV)) delete base[name]
    const modeRunner = (o: SandboxRunOptions): Promise<SandboxRunResult> =>
      bashRunner(o, { ...base, ...(o.allowNetwork ? {} : OFFLINE_FAIL_FAST_ENV) })
    const session = createShellSession(ws)
    const offline = await runInSession({
      command: 'echo "$PIP_RETRIES"; export CARGO_NET_RETRY=5',
      session,
      workspace: ws,
      allowNetwork: false,
      run: modeRunner
    })
    expect(offline.stdout.trim()).toBe(OFFLINE_FAIL_FAST_ENV.PIP_RETRIES)
    const online = await runInSession({
      command: 'echo "${PIP_RETRIES-unset} ${npm_config_fetch_retries-unset} ${CARGO_NET_RETRY-unset}"',
      session,
      workspace: ws,
      allowNetwork: true,
      run: modeRunner
    })
    expect(online.stdout.trim()).toBe('unset unset 5')
  })

  it('falls back to the project root when the session directory was deleted', async () => {
    mkdirSync(join(ws, 'build'))
    const session = createShellSession(ws)
    await runInSession({ command: 'cd build', session, workspace: ws, allowNetwork: false, run: bashRunner })
    // Deleted while the session still points at it (on macOS and Linux a later
    // command can even do it from inside: bash's pwd keeps reporting the old path).
    // Removed between commands here, since Windows won't delete a shell's own cwd.
    expect(canon(session.cwd)).toBe(canon(join(ws, 'build')))
    rmSync(join(ws, 'build'), { recursive: true, force: true })

    const cwds: string[] = []
    const recording = (o: SandboxRunOptions): Promise<SandboxRunResult> => {
      cwds.push(o.cwd)
      return bashRunner(o)
    }
    const res = await runInSession({ command: 'echo ok', session, workspace: ws, allowNetwork: false, run: recording })
    expect(cwds).toEqual([ws])
    expect(res.exitCode).toBe(0)
    expect(res.stdout.trim()).toBe('ok')
    expect(res.stderr).toContain('no longer exists, so this command ran from the project root')
    expect(canon(session.cwd)).toBe(canon(ws))

    // Recovered: the next command runs normally, without the note.
    const next = await runInSession({ command: 'echo again', session, workspace: ws, allowNetwork: false, run: bashRunner })
    expect(next.stdout.trim()).toBe('again')
    expect(next.stderr).toBe('')
  })

  it('preserves the command exit code', async () => {
    const session = createShellSession(ws)
    const res = await runInSession({
      command: 'exit 7',
      session,
      workspace: ws,
      allowNetwork: false,
      run: bashRunner
    })
    expect(res.exitCode).toBe(7)
  })
})
