import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, realpathSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import type { SandboxRunOptions, SandboxRunResult } from '../sandbox'
import {
  applySessionResult,
  buildSessionCommand,
  createShellSession,
  runInSession,
  singleQuote,
  type ShellSession
} from './shell-session'

/** A non-sandboxed runner that executes the wrapped command with plain bash, so
 * these tests run on Linux CI (no sandbox-exec) yet exercise the real wrapper. */
function bashRunner(opts: SandboxRunOptions): Promise<SandboxRunResult> {
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', ['-c', opts.command], { cwd: opts.cwd })
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
    expect(out).toContain(`pwd > '/t/c'`)
    expect(out).toContain(`export -p > '/t/e'`)
    expect(out).toContain('exit $__houston_ec')
  })

  it('only sources the env file when there is captured env', () => {
    expect(buildSessionCommand('ls', { cwd: '/p', env: '' }, paths)).not.toContain('source')
    expect(buildSessionCommand('ls', { cwd: '/p', env: 'declare -x A=1' }, paths)).toContain(
      `source '/t/i' 2>/dev/null`
    )
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

describe('runInSession (end to end with real bash)', () => {
  it('persists cwd across calls', async () => {
    mkdirSync(join(ws, 'sub'))
    const session = createShellSession(ws)
    await runInSession({ command: 'cd sub', session, workspace: ws, allowNetwork: false, run: bashRunner })
    expect(realpathSync(session.cwd)).toBe(realpathSync(join(ws, 'sub')))

    const res = await runInSession({
      command: 'pwd',
      session,
      workspace: ws,
      allowNetwork: false,
      run: bashRunner
    })
    expect(realpathSync(res.stdout.trim())).toBe(realpathSync(join(ws, 'sub')))
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
