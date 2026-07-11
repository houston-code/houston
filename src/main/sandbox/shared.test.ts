import { describe, expect, it, vi } from 'vitest'
import { join, sep } from 'node:path'
import { EventEmitter } from 'node:events'
import {
  augmentPath,
  CappedOutput,
  clampToolResult,
  pkgCacheDir,
  planKill,
  resolvePosixShell,
  runWithBackend,
  sandboxEnv,
  signalProcessTree,
  windowsKillCommands
} from './shared'
import { win32 } from 'node:path'
import type { SandboxBackend, SandboxRunOptions } from './contract'

describe('augmentPath', () => {
  // Pin the platform so these assertions are deterministic on every CI leg (incl. Windows).
  const minimalPath = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':')

  it('appends Homebrew and ~/.local/bin when they exist (POSIX)', () => {
    const out = augmentPath({ PATH: minimalPath, HOME: '/Users/me' }, () => true, 'darwin').split(':')
    expect(out).toContain('/opt/homebrew/bin')
    expect(out).toContain('/opt/homebrew/sbin')
    expect(out).toContain('/Users/me/.local/bin')
  })

  it('preserves inherited entries first and does not duplicate them (POSIX)', () => {
    const out = augmentPath({ PATH: minimalPath }, () => true, 'darwin').split(':')
    expect(out.slice(0, 4)).toEqual(['/usr/bin', '/bin', '/usr/sbin', '/sbin'])
    expect(out.filter((d) => d === '/usr/bin')).toHaveLength(1) // /usr/bin is also a candidate
  })

  it('adds nothing when the extra dirs do not exist (POSIX)', () => {
    expect(augmentPath({ PATH: minimalPath }, () => false, 'darwin')).toBe(minimalPath)
  })

  it('builds a PATH from scratch when none is inherited (POSIX)', () => {
    const out = augmentPath({ HOME: '/Users/me' }, () => true, 'darwin').split(':')
    expect(out).toContain('/opt/homebrew/bin')
    expect(out).not.toContain('') // no empty segments
  })

  it('omits ~/.local/bin when HOME is unset (POSIX)', () => {
    const out = augmentPath({ PATH: '/usr/bin' }, () => true, 'darwin')
    expect(out).not.toMatch(/\.local\/bin/)
  })

  it('leaves the inherited PATH untouched on Windows (no POSIX dirs, no ~/.local/bin)', () => {
    const winPath = ['C:\\Windows\\System32', 'C:\\Program Files\\Git\\bin'].join(';')
    const out = augmentPath({ PATH: winPath, HOME: 'C:\\Users\\me' }, () => true, 'win32')
    expect(out).toBe(winPath)
    expect(out).not.toContain('/opt/homebrew/bin')
    expect(out).not.toContain('.local')
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
    const filler = Buffer.from('x'.repeat(64 * 1024))
    for (let written = 0; written < 1_500_000; written += filler.length) cap.push(filler)
    cap.push(Buffer.from(tail))

    const out = cap.toString()
    expect(out.startsWith(head)).toBe(true)
    expect(out.endsWith(tail)).toBe(true)
    expect(out).toMatch(MARKER)
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

  it('redirects the Go build + module caches into the writable temp cache dir', () => {
    const env = sandboxEnv({ PATH: '/usr/bin', HOME: '/Users/me', TMPDIR: '/tmp' })
    const cache = pkgCacheDir({ TMPDIR: '/tmp' })
    expect(env.GOCACHE).toBe(`${cache}${sep}go-build`)
    expect(env.GOMODCACHE).toBe(`${cache}${sep}go-mod`)
    expect(env.GOCACHE).not.toMatch(/Users[/\\]me/) // not ~/Library/Caches — that's the EPERM we fix
  })

  it('redirects the Cargo home into the writable temp cache dir', () => {
    const env = sandboxEnv({ PATH: '/usr/bin', HOME: '/Users/me', TMPDIR: '/tmp' })
    const cache = pkgCacheDir({ TMPDIR: '/tmp' })
    expect(env.CARGO_HOME).toBe(`${cache}${sep}cargo`)
    expect(env.CARGO_HOME).not.toMatch(/Users[/\\]me/) // not ~/.cargo — that's the EPERM we fix
  })

  it('redirects the node-gyp devdir into the writable temp cache dir', () => {
    const env = sandboxEnv({ PATH: '/usr/bin', HOME: '/Users/me', TMPDIR: '/tmp' })
    const cache = pkgCacheDir({ TMPDIR: '/tmp' })
    expect(env.npm_config_devdir).toBe(`${cache}${sep}node-gyp`)
    expect(env.npm_config_devdir).not.toMatch(/Users[/\\]me/) // not ~/.node-gyp — that's the EPERM we fix
  })

  it('redirects the Gradle/Deno/Bun caches into the writable temp cache dir', () => {
    const env = sandboxEnv({ PATH: '/usr/bin', HOME: '/Users/me', TMPDIR: '/tmp' })
    const cache = pkgCacheDir({ TMPDIR: '/tmp' })
    expect(env.GRADLE_USER_HOME).toBe(`${cache}${sep}gradle`)
    expect(env.DENO_DIR).toBe(`${cache}${sep}deno`)
    expect(env.BUN_INSTALL_CACHE_DIR).toBe(`${cache}${sep}bun`)
    expect(env.GRADLE_USER_HOME).not.toMatch(/Users[/\\]me/) // not ~/.gradle — that's the EPERM we fix
  })

  it('keeps the cache under the temp area (sandbox-writable), never $HOME', () => {
    // Use join() on both sides so this is correct on Windows (where the path
    // separator and join semantics differ from POSIX).
    const cache = pkgCacheDir({ TMPDIR: '/tmp' })
    expect(cache).toBe(join('/tmp', 'houston-pkg-cache'))
    const env = sandboxEnv({ HOME: '/Users/me', TMPDIR: '/tmp' })
    expect(env.npm_config_cache).not.toMatch(/Users[/\\]me/) // not ~/.npm — that's the EPERM we fix
  })

  it('preserves other env vars and augments PATH', () => {
    const env = sandboxEnv({ PATH: '/usr/bin', FOO: 'bar', TMPDIR: '/tmp' })
    expect(env.FOO).toBe('bar')
    expect(env.PATH).toContain('/usr/bin')
  })

  it('strips credential-bearing vars from the launching shell (defense-in-depth)', () => {
    const env = sandboxEnv({
      PATH: '/usr/bin',
      HOME: '/Users/me',
      TMPDIR: '/tmp',
      AWS_SECRET_ACCESS_KEY: 'AKIA-super-secret',
      GH_TOKEN: 'ghp_leakme',
      OPENAI_API_KEY: 'sk-leakme'
    })
    // Secrets never reach the sandboxed child…
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(env.GH_TOKEN).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBeUndefined()
    // …while the augmented PATH, HOME, and cache redirects still do.
    expect(env.PATH).toContain('/usr/bin')
    expect(env.HOME).toBe('/Users/me')
    expect(env.npm_config_cache).toBe(`${pkgCacheDir({ TMPDIR: '/tmp' })}${sep}npm`)
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
    expect(out.startsWith('START')).toBe(true)
    expect(out.endsWith('END')).toBe(true)
    expect(out).toMatch(MARKER)
    expect(out.length).toBeLessThan(text.length)
  })

  it('bounds a multi-hundred-KB result to roughly the default budget', () => {
    const out = clampToolResult('y'.repeat(500_000))
    expect(out).toMatch(MARKER)
    expect(out.length).toBeLessThanOrEqual(64_000 + 64) // budget + short marker line
  })
})

describe('resolvePosixShell', () => {
  it('prefers /bin/bash when present (isBash → session prelude usable)', () => {
    expect(resolvePosixShell((p) => p === '/bin/bash')).toEqual({ shell: '/bin/bash', isBash: true })
  })

  it('finds bash outside /bin (e.g. /usr/bin/bash) when /bin/bash is absent', () => {
    expect(resolvePosixShell((p) => p === '/usr/bin/bash')).toEqual({
      shell: '/usr/bin/bash',
      isBash: true
    })
    expect(resolvePosixShell((p) => p === '/usr/local/bin/bash')).toEqual({
      shell: '/usr/local/bin/bash',
      isBash: true
    })
  })

  it('falls back to POSIX /bin/sh (NOT zsh) and reports isBash false when no bash exists', () => {
    expect(resolvePosixShell(() => false)).toEqual({ shell: '/bin/sh', isBash: false })
  })

  it('honors the /bin/bash preference order when several bash paths exist', () => {
    expect(resolvePosixShell(() => true).shell).toBe('/bin/bash')
  })
})

describe('planKill', () => {
  it('SIGKILLs the negative pid (process group) on non-Windows hosts', () => {
    expect(planKill('darwin', 4242)).toEqual({ kind: 'group', target: -4242 })
    expect(planKill('linux', 4242)).toEqual({ kind: 'group', target: -4242 })
  })

  it('uses taskkill /T /F on Windows (negative-pid group kill is invalid there)', () => {
    expect(planKill('win32', 4242)).toEqual({
      kind: 'taskkill',
      file: 'taskkill',
      args: ['/pid', '4242', '/T', '/F']
    })
  })
})

describe('windowsKillCommands', () => {
  const args = ['/pid', '4242', '/T', '/F']

  it('tries bare taskkill first, then the absolute System32 path under %SystemRoot%', () => {
    expect(windowsKillCommands(4242, { SystemRoot: 'C:\\Windows' })).toEqual([
      { file: 'taskkill', args },
      { file: win32.join('C:\\Windows', 'System32', 'taskkill.exe'), args }
    ])
  })

  it('falls back to %windir% when %SystemRoot% is unset', () => {
    expect(windowsKillCommands(4242, { windir: 'D:\\WINNT' })).toEqual([
      { file: 'taskkill', args },
      { file: win32.join('D:\\WINNT', 'System32', 'taskkill.exe'), args }
    ])
  })

  it('yields only the bare name when neither env var is present', () => {
    expect(windowsKillCommands(4242, {})).toEqual([{ file: 'taskkill', args }])
  })

  it('every command reaps the whole tree (/T /F) by pid', () => {
    for (const cmd of windowsKillCommands(99, { SystemRoot: 'C:\\Windows' })) {
      expect(cmd.args).toEqual(['/pid', '99', '/T', '/F'])
    }
  })
})

describe('runWithBackend — honest sandboxed flag', () => {
  function makeFakeChild(pid = 4242): any {
    const child: any = new EventEmitter()
    child.pid = pid
    child.exitCode = null
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = vi.fn()
    return child
  }

  function fakeSpawn(child: any): any {
    const calls: any[] = []
    const fn: any = (cmd: string, args: string[], options: any) => {
      calls.push({ cmd, args, options })
      return child
    }
    fn.calls = calls
    return fn
  }

  const fakeBackend = (sandboxed: boolean, file = 'wrapper'): SandboxBackend => ({
    id: sandboxed ? 'seatbelt' : 'none',
    sandboxed,
    confinesNetwork: sandboxed,
    supportsSession: true,
    buildLaunch: ({ command }) => ({
      file,
      args: ['-c', command],
      detached: true,
      windowsHide: false,
      supportsSession: true
    })
  })

  const baseOpts = (over: Partial<SandboxRunOptions> = {}): SandboxRunOptions => ({
    command: 'echo hi',
    cwd: '/tmp',
    workspace: '/tmp',
    allowNetwork: false,
    ...over
  })

  it('reports result.sandboxed = backend.sandboxed (true)', async () => {
    const child = makeFakeChild()
    const p = runWithBackend(fakeBackend(true), baseOpts(), {
      spawn: fakeSpawn(child),
      signalTree: vi.fn(),
      drainMs: 20
    })
    child.emit('close', 0)
    expect((await p).sandboxed).toBe(true)
  })

  it('reports result.sandboxed = backend.sandboxed (false) — honest on unconfined hosts', async () => {
    const child = makeFakeChild()
    const p = runWithBackend(fakeBackend(false), baseOpts(), {
      spawn: fakeSpawn(child),
      signalTree: vi.fn(),
      drainMs: 20
    })
    child.emit('close', 0)
    expect((await p).sandboxed).toBe(false)
  })

  it('launches the backend-provided file and spawns detached', () => {
    const child = makeFakeChild()
    const spawn = fakeSpawn(child)
    runWithBackend(fakeBackend(false, 'my-wrapper'), baseOpts(), {
      spawn,
      signalTree: vi.fn(),
      drainMs: 20
    })
    expect(spawn.calls[0].cmd).toBe('my-wrapper')
    expect(spawn.calls[0].options.detached).toBe(true)
    // Abort is handled by our own tree-signal path, never delegated to spawn's own
    // signal option (which would kill only the wrapper, not the tree).
    expect(spawn.calls[0].options.signal).toBeUndefined()
  })

  it('honors a custom timeoutMs and reports timedOut, terminating gracefully', async () => {
    vi.useFakeTimers()
    try {
      const child = makeFakeChild()
      const signalTree = vi.fn()
      const p = runWithBackend(fakeBackend(true), baseOpts({ timeoutMs: 1_000 }), {
        spawn: fakeSpawn(child),
        signalTree,
        killGraceMs: 500,
        drainMs: 20
      })
      // Before the deadline: no signal yet.
      await vi.advanceTimersByTimeAsync(999)
      expect(signalTree).not.toHaveBeenCalled()
      // Deadline: SIGTERM first (let the tree flush/roll back), NOT an immediate SIGKILL.
      await vi.advanceTimersByTimeAsync(1)
      expect(signalTree).toHaveBeenCalledWith(child, 'SIGTERM')
      expect(signalTree).not.toHaveBeenCalledWith(child, 'SIGKILL')
      // Grace elapses without the process exiting → escalate to SIGKILL, then settle.
      await vi.advanceTimersByTimeAsync(500)
      expect(signalTree).toHaveBeenCalledWith(child, 'SIGKILL')
      await vi.advanceTimersByTimeAsync(20)
      const r = await p
      expect(r.timedOut).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('settles without SIGKILL when the process exits during the SIGTERM grace window', async () => {
    vi.useFakeTimers()
    try {
      const child = makeFakeChild()
      const signalTree = vi.fn()
      const p = runWithBackend(fakeBackend(true), baseOpts({ timeoutMs: 1_000 }), {
        spawn: fakeSpawn(child),
        signalTree,
        killGraceMs: 500,
        drainMs: 20
      })
      await vi.advanceTimersByTimeAsync(1_000) // timeout → SIGTERM
      child.exitCode = 143
      child.emit('close', 143) // the process obeyed SIGTERM
      const r = await p
      expect(signalTree).toHaveBeenCalledWith(child, 'SIGTERM')
      expect(signalTree).not.toHaveBeenCalledWith(child, 'SIGKILL')
      expect(r.timedOut).toBe(true)
      expect(r.exitCode).toBe(143)
    } finally {
      vi.useRealTimers()
    }
  })

  it('terminates the tree gracefully on abort (SIGTERM, not delegated to spawn)', async () => {
    vi.useFakeTimers()
    try {
      const child = makeFakeChild()
      const signalTree = vi.fn()
      const ac = new AbortController()
      const p = runWithBackend(fakeBackend(true), baseOpts({ signal: ac.signal }), {
        spawn: fakeSpawn(child),
        signalTree,
        killGraceMs: 500,
        drainMs: 20
      })
      ac.abort()
      expect(signalTree).toHaveBeenCalledWith(child, 'SIGTERM')
      await vi.advanceTimersByTimeAsync(500)
      expect(signalTree).toHaveBeenCalledWith(child, 'SIGKILL')
      await vi.advanceTimersByTimeAsync(20)
      await p
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('signalProcessTree', () => {
  it.skipIf(process.platform === 'win32')(
    'sends the given signal to the whole process group on POSIX',
    () => {
      const child: any = { pid: 4242, kill: vi.fn() }
      const spy = vi.spyOn(process, 'kill').mockImplementation(() => true)
      try {
        signalProcessTree(child, 'SIGTERM')
        expect(spy).toHaveBeenCalledWith(-4242, 'SIGTERM')
        signalProcessTree(child, 'SIGKILL')
        expect(spy).toHaveBeenCalledWith(-4242, 'SIGKILL')
      } finally {
        spy.mockRestore()
      }
    }
  )

  it('is a no-op when the child has no pid', () => {
    const child: any = { pid: undefined, kill: vi.fn() }
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      signalProcessTree(child, 'SIGTERM')
      expect(spy).not.toHaveBeenCalled()
      expect(child.kill).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})
