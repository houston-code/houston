import { describe, expect, it, vi } from 'vitest'
import { delimiter, sep } from 'node:path'
import { EventEmitter } from 'node:events'
import {
  augmentPath,
  CappedOutput,
  clampToolResult,
  pkgCacheDir,
  runSandboxed,
  sandboxAvailable,
  sandboxEnv,
  type SandboxRunOptions
} from './sandbox'

describe('augmentPath', () => {
  const minimalPath = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter)

  it('appends Homebrew and ~/.local/bin when they exist', () => {
    const out = augmentPath({ PATH: minimalPath, HOME: '/Users/me' }, () => true).split(delimiter)
    expect(out).toContain('/opt/homebrew/bin')
    expect(out).toContain('/opt/homebrew/sbin')
    expect(out).toContain('/Users/me/.local/bin')
  })

  it('preserves inherited entries first and does not duplicate them', () => {
    const out = augmentPath({ PATH: minimalPath }, () => true).split(delimiter)
    expect(out.slice(0, 4)).toEqual(['/usr/bin', '/bin', '/usr/sbin', '/sbin'])
    expect(out.filter((d) => d === '/usr/bin')).toHaveLength(1) // /usr/bin is also a candidate
  })

  it('adds nothing when the extra dirs do not exist', () => {
    expect(augmentPath({ PATH: minimalPath }, () => false)).toBe(minimalPath)
  })

  it('builds a PATH from scratch when none is inherited', () => {
    const out = augmentPath({ HOME: '/Users/me' }, () => true).split(delimiter)
    expect(out).toContain('/opt/homebrew/bin')
    expect(out).not.toContain('') // no empty segments
  })

  it('omits ~/.local/bin when HOME is unset', () => {
    const out = augmentPath({ PATH: '/usr/bin' }, () => true)
    expect(out).not.toMatch(/\.local\/bin/)
  })
})

describe('sandboxAvailable', () => {
  it('is true only on macOS with the sandbox-exec binary present', () => {
    expect(sandboxAvailable('darwin', (p) => p === '/usr/bin/sandbox-exec')).toBe(true)
  })

  it('is false on macOS when the sandbox-exec binary is missing', () => {
    // A Seatbelt-less macOS — the comment used to claim this was checked; now it is.
    expect(sandboxAvailable('darwin', () => false)).toBe(false)
  })

  it('is false on non-macOS platforms regardless of any binary', () => {
    expect(sandboxAvailable('linux', () => true)).toBe(false)
    expect(sandboxAvailable('win32', () => true)).toBe(false)
  })
})

describe('CappedOutput', () => {
  const MARKER = /\n\[\.\.\. (\d+) bytes truncated \.\.\.\]\n/

  it('returns output verbatim when it fits the budget', () => {
    const cap = new CappedOutput(5, 5)
    cap.push(Buffer.from('hello'))
    expect(cap.toString()).toBe('hello')
    expect(cap.droppedBytes).toBe(0)
    expect(cap.toString()).not.toMatch(MARKER)
  })

  it('keeps head and tail contiguous (no marker) right at the budget edge', () => {
    const cap = new CappedOutput(3, 3)
    cap.push(Buffer.from('abcXYZ')) // exactly head+tail bytes
    expect(cap.toString()).toBe('abcXYZ')
    expect(cap.droppedBytes).toBe(0)
  })

  it('preserves BOTH ends with a truncation marker once over budget', () => {
    const cap = new CappedOutput(3, 3)
    cap.push(Buffer.from('abc' + 'M'.repeat(10) + 'xyz'))
    const out = cap.toString()
    expect(out.startsWith('abc')).toBe(true) // head survives
    expect(out.endsWith('xyz')).toBe(true) // tail survives
    expect(out).toMatch(MARKER)
    expect(cap.droppedBytes).toBe(10)
    expect(out).toContain('[... 10 bytes truncated ...]')
  })

  it('rolls the tail window across chunk boundaries, keeping the last bytes', () => {
    const cap = new CappedOutput(2, 4)
    // Head fills with "AB"; the rest streams in many small chunks. Only the last
    // 4 bytes of the post-head stream should remain in the tail.
    cap.push(Buffer.from('AB'))
    for (const ch of 'CDEFGHIJ') cap.push(Buffer.from(ch))
    const out = cap.toString()
    expect(out.startsWith('AB')).toBe(true)
    expect(out.endsWith('GHIJ')).toBe(true)
    expect(cap.droppedBytes).toBe('CDEF'.length) // C,D,E,F dropped between ends
  })

  it('keeps the trailing summary when fed more than 1 MB (default budget)', () => {
    const cap = new CappedOutput() // default 1 MB budget, split head/tail
    const head = 'compiling...\n'
    const tail = '\n5 failed, 120 passed'
    cap.push(Buffer.from(head))
    // > 1 MB of noise in the middle, in many chunks like a real stream.
    const filler = Buffer.from('x'.repeat(64 * 1024))
    for (let written = 0; written < 1_500_000; written += filler.length) cap.push(filler)
    cap.push(Buffer.from(tail))

    const out = cap.toString()
    expect(out.startsWith(head)).toBe(true) // command echo / early output survives
    expect(out.endsWith(tail)).toBe(true) // the actionable summary survives
    expect(out).toMatch(MARKER)
    // Retained output stays within the 1 MB budget (plus the short marker line).
    expect(out.length).toBeLessThanOrEqual(1_000_000 + 64)
    expect(cap.droppedBytes).toBeGreaterThan(0)
  })

  it('handles a single over-budget chunk by keeping its head and tail', () => {
    const cap = new CappedOutput(4, 4)
    cap.push(Buffer.from('HEAD' + '-'.repeat(20) + 'TAIL'))
    const out = cap.toString()
    expect(out.startsWith('HEAD')).toBe(true)
    expect(out.endsWith('TAIL')).toBe(true)
    expect(cap.droppedBytes).toBe(20)
  })
})

describe('sandboxEnv', () => {
  it('redirects package-manager caches into the writable temp cache dir', () => {
    const env = sandboxEnv({ PATH: '/usr/bin', HOME: '/Users/me', TMPDIR: '/tmp' })
    const cache = pkgCacheDir({ TMPDIR: '/tmp' })
    expect(env.npm_config_cache).toBe(`${cache}${sep}npm`)
    expect(env.YARN_CACHE_FOLDER).toBe(`${cache}${sep}yarn`)
    expect(env.PIP_CACHE_DIR).toBe(`${cache}${sep}pip`)
    expect(env.XDG_CACHE_HOME).toBe(`${cache}${sep}xdg`)
  })

  it('keeps the cache under the temp area (sandbox-writable), never $HOME', () => {
    const cache = pkgCacheDir({ TMPDIR: '/tmp' })
    expect(cache.startsWith(`/tmp${sep}`)).toBe(true)
    const env = sandboxEnv({ HOME: '/Users/me', TMPDIR: '/tmp' })
    expect(env.npm_config_cache).not.toMatch(/\/Users\/me/) // not ~/.npm — that's the EPERM we fix
  })

  it('preserves other env vars and augments PATH', () => {
    const env = sandboxEnv({ PATH: '/usr/bin', FOO: 'bar', TMPDIR: '/tmp' })
    expect(env.FOO).toBe('bar')
    expect(env.PATH).toContain('/usr/bin')
  })
})

describe('clampToolResult', () => {
  const MARKER = /\n\[\.\.\. (\d+) bytes truncated \.\.\.\]\n/

  it('returns output verbatim when it fits the budget', () => {
    expect(clampToolResult('all good', 64)).toBe('all good')
    expect(clampToolResult('all good')).toBe('all good') // default budget
  })

  it('keeps both ends with a truncation marker when over budget', () => {
    const text = 'START' + 'x'.repeat(1000) + 'END'
    const out = clampToolResult(text, 20)
    expect(out.startsWith('START')).toBe(true) // command echo / early errors survive
    expect(out.endsWith('END')).toBe(true) // trailing summary survives
    expect(out).toMatch(MARKER)
    expect(out.length).toBeLessThan(text.length)
  })

  it('bounds a multi-hundred-KB result to roughly the default budget', () => {
    const out = clampToolResult('y'.repeat(500_000))
    expect(out).toMatch(MARKER)
    expect(out.length).toBeLessThanOrEqual(64_000 + 64) // budget + short marker line
  })
})

describe('runSandboxed', () => {
  // A stand-in for the `sandbox-exec` ChildProcess: an EventEmitter with stdio
  // emitters and a settable exitCode, so tests can drive exit/close/error/data.
  function makeFakeChild(pid = 4242): any {
    const child: any = new EventEmitter()
    child.pid = pid
    child.exitCode = null
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = vi.fn()
    return child
  }

  // A fake `spawn` that always returns `child` and records how it was called.
  function fakeSpawn(child: any): any {
    const calls: any[] = []
    const fn: any = (cmd: string, args: string[], options: any) => {
      calls.push({ cmd, args, options })
      return child
    }
    fn.calls = calls
    return fn
  }

  const baseOpts = (over: Partial<SandboxRunOptions> = {}): SandboxRunOptions => ({
    command: 'echo hi',
    cwd: '/tmp',
    workspace: '/tmp',
    allowNetwork: false,
    ...over
  })

  it('captures stdout/stderr/exit code and settles on stdio close', async () => {
    const child = makeFakeChild()
    const killTree = vi.fn()
    const p = runSandboxed(baseOpts(), {
      spawn: fakeSpawn(child),
      killTree,
      drainMs: 50,
      available: () => true
    })

    child.stdout.emit('data', Buffer.from('hello '))
    child.stderr.emit('data', Buffer.from('warn'))
    child.exitCode = 0
    child.emit('exit', 0)
    child.emit('close', 0)

    const res = await p
    expect(res).toEqual({
      stdout: 'hello ',
      stderr: 'warn',
      exitCode: 0,
      timedOut: false,
      sandboxed: true
    })
    expect(killTree).not.toHaveBeenCalled()
  })

  it('reports sandboxed:false honestly when the sandbox is not in effect', async () => {
    // The result must not claim confinement that isn't there — the approval path
    // and the run_shell output key off this to avoid silent unconfined execution.
    const child = makeFakeChild()
    const p = runSandboxed(baseOpts(), {
      spawn: fakeSpawn(child),
      killTree: vi.fn(),
      drainMs: 50,
      available: () => false
    })
    child.exitCode = 0
    child.emit('exit', 0)
    child.emit('close', 0)

    const res = await p
    expect(res.sandboxed).toBe(false)
  })

  it('spawns the command detached so the whole tree is killable', () => {
    const child = makeFakeChild()
    const spawn = fakeSpawn(child)
    runSandboxed(baseOpts(), { spawn, killTree: vi.fn(), drainMs: 50 })
    expect(spawn.calls[0].cmd).toBe('sandbox-exec')
    expect(spawn.calls[0].options.detached).toBe(true)
    // The abort plumbing must not be delegated to spawn's own signal option,
    // which would only kill the wrapper, not the process tree.
    expect(spawn.calls[0].options.signal).toBeUndefined()
  })

  // Regression: the hang that froze the "Build a web app…" chat. On timeout the
  // wrapper is killed but an orphaned grandchild (npm/node) keeps the stdout pipe
  // open, so 'close' never fires. The call must still settle via the drain backstop.
  it('settles on timeout even when stdio never closes (orphaned pipe)', async () => {
    const child = makeFakeChild()
    const killTree = vi.fn()
    const p = runSandboxed(baseOpts({ timeoutMs: 10 }), {
      spawn: fakeSpawn(child),
      killTree,
      drainMs: 10
    })

    child.stdout.emit('data', Buffer.from('npm install starting'))
    // Intentionally never emit 'exit' or 'close' — the grandchild holds the pipe.

    const res = await p
    expect(res.timedOut).toBe(true)
    expect(res.stdout).toContain('npm install starting')
    expect(killTree).toHaveBeenCalledWith(child)
  })

  it('settles shortly after exit when an orphan holds the pipe open (no close)', async () => {
    const child = makeFakeChild()
    const killTree = vi.fn()
    const p = runSandboxed(baseOpts(), { spawn: fakeSpawn(child), killTree, drainMs: 10 })

    child.stdout.emit('data', Buffer.from('done'))
    child.exitCode = 0
    child.emit('exit', 0) // wrapper exits; a backgrounded child keeps stdout open
    // 'close' intentionally never emitted

    const res = await p
    expect(res.exitCode).toBe(0)
    expect(res.timedOut).toBe(false)
    expect(res.stdout).toBe('done')
    expect(killTree).not.toHaveBeenCalled()
  })

  it('kills the whole process tree when the run is aborted', async () => {
    const child = makeFakeChild()
    const killTree = vi.fn()
    const ac = new AbortController()
    const p = runSandboxed(baseOpts({ signal: ac.signal }), {
      spawn: fakeSpawn(child),
      killTree,
      drainMs: 10,
      available: () => true
    })

    ac.abort()
    expect(killTree).toHaveBeenCalledWith(child)

    child.emit('exit', null) // tree dies from the kill
    const res = await p
    expect(res.sandboxed).toBe(true)
  })

  it('kills the tree immediately when the signal is already aborted', () => {
    const child = makeFakeChild()
    const killTree = vi.fn()
    runSandboxed(baseOpts({ signal: AbortSignal.abort() }), {
      spawn: fakeSpawn(child),
      killTree,
      drainMs: 10
    })
    expect(killTree).toHaveBeenCalledWith(child)
  })

  it('resolves with an error message when the process fails to launch', async () => {
    const child = makeFakeChild()
    const p = runSandboxed(baseOpts(), { spawn: fakeSpawn(child), killTree: vi.fn(), drainMs: 10 })

    child.emit('error', new Error('spawn sandbox-exec ENOENT'))

    const res = await p
    expect(res.exitCode).toBeNull()
    expect(res.stderr).toContain('ENOENT')
    expect(res.stdout).toBe('')
    // The sandboxed process never started, so the run was not confined.
    expect(res.sandboxed).toBe(false)
  })
})
