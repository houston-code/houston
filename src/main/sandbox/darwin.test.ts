import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { buildSeatbeltProfile, seatbeltNetworkMode, SeatbeltBackend } from './darwin'
import { runWithBackend } from './shared'
import type { SandboxRunOptions } from './contract'

describe('buildSeatbeltProfile', () => {
  it('denies by default and allows reads everywhere', () => {
    const p = buildSeatbeltProfile('/work', false)
    expect(p).toContain('(deny default)')
    expect(p).toContain('(allow file-read*)')
    expect(p).toContain('(allow process-exec)')
    expect(p).toContain('(allow process-fork)')
  })

  it('makes each writable root a write subpath, plus the temp dirs', () => {
    const p = buildSeatbeltProfile(['/work/a', '/work/b'], false)
    expect(p).toContain('(subpath "/work/a")')
    expect(p).toContain('(subpath "/work/b")')
    expect(p).toContain('(subpath "/private/tmp")')
    expect(p).toContain('(subpath "/private/var/tmp")')
  })

  it('gates network on allowNetwork', () => {
    expect(buildSeatbeltProfile('/work', true)).toContain('(allow network*)')
    const denied = buildSeatbeltProfile('/work', false)
    expect(denied).not.toContain('(allow network*)')
    expect(denied).toContain('; network denied')
  })

  it('loopback mode allows only loopback traffic (proxied egress), never network*', () => {
    const p = buildSeatbeltProfile('/work', 'loopback')
    expect(p).toContain('(allow network-outbound (remote ip "localhost:*"))')
    expect(p).toContain('(allow network-bind (local ip "localhost:*"))')
    expect(p).toContain('(allow network-inbound (local ip "localhost:*"))')
    expect(p).not.toContain('(allow network*)')
    // DNS is explicitly cut, not merely left un-opened: getaddrinfo resolves via
    // the mDNSResponder mach service (outside the sandbox), which a socket-only
    // restriction wouldn't gate — so we DENY the resolver services to close the
    // DNS-tunnel exfil channel. The deny lands after the body's blanket
    // (allow mach-lookup) (SBPL last-match-wins), scoping out only the resolver.
    expect(p).toContain('(deny mach-lookup (global-name "com.apple.mDNSResponder")')
    expect(p).toContain('(global-name "com.apple.dnssd.service"))')
    const denyIdx = p.indexOf('(deny mach-lookup')
    expect(denyIdx).toBeGreaterThan(p.indexOf('(allow mach-lookup)'))
  })

  it('no-network mode also denies the DNS resolver services', () => {
    const p = buildSeatbeltProfile('/work', false)
    expect(p).toContain('(deny mach-lookup (global-name "com.apple.mDNSResponder")')
  })

  it('full mode keeps DNS (unrestricted network implies resolution) — no resolver deny', () => {
    const p = buildSeatbeltProfile('/work', true)
    expect(p).toContain('(allow network*)')
    expect(p).not.toContain('(deny mach-lookup')
  })

  it('drops empty roots and accepts a single string root', () => {
    const p = buildSeatbeltProfile(['/work', ''], false)
    expect(p).toContain('(subpath "/work")')
    // No empty-path subpath leaked in.
    expect(p).not.toMatch(/\(subpath ""\)/)
  })
})

describe('SeatbeltBackend.buildLaunch', () => {
  it('wraps the command in sandbox-exec with the generated profile', () => {
    const launch = SeatbeltBackend.buildLaunch({
      command: 'echo hi',
      roots: ['/work'],
      allowNetwork: false,
      cwd: '/work'
    })
    expect(launch.file).toBe('sandbox-exec')
    expect(launch.args[0]).toBe('-p')
    expect(launch.args[1]).toContain('(deny default)')
    expect(launch.args.slice(2)).toEqual(['/bin/bash', '-c', 'echo hi'])
    expect(launch.detached).toBe(true)
    expect(launch.windowsHide).toBe(false)
  })

  it('reports itself as a confining backend', () => {
    expect(SeatbeltBackend.id).toBe('seatbelt')
    expect(SeatbeltBackend.sandboxed).toBe(true)
    expect(SeatbeltBackend.confinesNetwork).toBe(true)
  })

  it('switches to loopback-only + proxy env when network is granted with egress endpoints', () => {
    const launch = SeatbeltBackend.buildLaunch({
      command: 'curl https://registry.npmjs.org/',
      roots: ['/work'],
      allowNetwork: true,
      egressProxy: { tcpPort: 9137 },
      cwd: '/work'
    })
    expect(launch.args[1]).toContain('(allow network-outbound (remote ip "localhost:*"))')
    expect(launch.args[1]).not.toContain('(allow network*)')
    expect(launch.env?.HTTPS_PROXY).toBe('http://127.0.0.1:9137')
    expect(launch.env?.http_proxy).toBe('http://127.0.0.1:9137')
    expect(launch.env?.NO_PROXY).toContain('localhost')
  })

  it('granted network WITHOUT egress endpoints stays full (legacy mode-all), no proxy env', () => {
    const launch = SeatbeltBackend.buildLaunch({
      command: 'curl https://anything.example/',
      roots: ['/work'],
      allowNetwork: true,
      cwd: '/work'
    })
    expect(launch.args[1]).toContain('(allow network*)')
    expect(launch.env).toBeUndefined()
  })

  it('denied network ignores egress endpoints (no grant means no road out at all)', () => {
    const launch = SeatbeltBackend.buildLaunch({
      command: 'echo hi',
      roots: ['/work'],
      allowNetwork: false,
      egressProxy: { tcpPort: 9137 },
      cwd: '/work'
    })
    expect(launch.args[1]).toContain('; network denied')
    expect(launch.env).toBeUndefined()
  })

  it('seatbeltNetworkMode maps the grant/endpoints combinations', () => {
    expect(seatbeltNetworkMode(false, undefined)).toBe('none')
    expect(seatbeltNetworkMode(false, { tcpPort: 1 })).toBe('none')
    expect(seatbeltNetworkMode(true, undefined)).toBe('full')
    expect(seatbeltNetworkMode(true, { tcpPort: 1 })).toBe('loopback')
  })
})

// The run/capture/timeout/drain/abort lifecycle is shared, but we exercise it through
// the Seatbelt backend (with a faked spawn) so these assertions hold on any host.
describe('runWithBackend(SeatbeltBackend) lifecycle', () => {
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

  const baseOpts = (over: Partial<SandboxRunOptions> = {}): SandboxRunOptions => ({
    command: 'echo hi',
    cwd: '/tmp',
    workspace: '/tmp',
    allowNetwork: false,
    ...over
  })

  const run = (opts: SandboxRunOptions, deps: any) => runWithBackend(SeatbeltBackend, opts, deps)

  it('captures stdout/stderr/exit code and settles on stdio close, sandboxed=true', async () => {
    const child = makeFakeChild()
    const signalTree = vi.fn()
    const p = run(baseOpts(), { spawn: fakeSpawn(child), signalTree, drainMs: 50 })

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
    expect(signalTree).not.toHaveBeenCalled()
  })

  it('spawns sandbox-exec detached so the whole tree is killable', () => {
    const child = makeFakeChild()
    const spawn = fakeSpawn(child)
    run(baseOpts(), { spawn, signalTree: vi.fn(), drainMs: 50 })
    expect(spawn.calls[0].cmd).toBe('sandbox-exec')
    expect(spawn.calls[0].options.detached).toBe(true)
    expect(spawn.calls[0].options.signal).toBeUndefined()
  })

  it('settles on timeout even when stdio never closes (orphaned pipe)', async () => {
    const child = makeFakeChild()
    const signalTree = vi.fn()
    const p = run(baseOpts({ timeoutMs: 10 }), {
      spawn: fakeSpawn(child),
      signalTree,
      killGraceMs: 10,
      drainMs: 10
    })

    child.stdout.emit('data', Buffer.from('npm install starting'))
    // Intentionally never emit 'exit' or 'close' — the grandchild holds the pipe.

    const res = await p
    expect(res.timedOut).toBe(true)
    expect(res.stdout).toContain('npm install starting')
    // SIGTERM first (let a package manager roll back), then SIGKILL for the straggler.
    expect(signalTree).toHaveBeenCalledWith(child, 'SIGTERM')
    expect(signalTree).toHaveBeenCalledWith(child, 'SIGKILL')
  })

  it('settles shortly after exit when an orphan holds the pipe open (no close)', async () => {
    const child = makeFakeChild()
    const signalTree = vi.fn()
    const p = run(baseOpts(), { spawn: fakeSpawn(child), signalTree, drainMs: 10 })

    child.stdout.emit('data', Buffer.from('done'))
    child.exitCode = 0
    child.emit('exit', 0)

    const res = await p
    expect(res.exitCode).toBe(0)
    expect(res.timedOut).toBe(false)
    expect(res.stdout).toBe('done')
    expect(signalTree).not.toHaveBeenCalled()
  })

  it('terminates the whole process tree when the run is aborted', async () => {
    const child = makeFakeChild()
    const signalTree = vi.fn()
    const ac = new AbortController()
    const p = run(baseOpts({ signal: ac.signal }), {
      spawn: fakeSpawn(child),
      signalTree,
      killGraceMs: 10,
      drainMs: 10
    })

    ac.abort()
    expect(signalTree).toHaveBeenCalledWith(child, 'SIGTERM')

    child.emit('exit', null)
    const res = await p
    expect(res.sandboxed).toBe(true)
  })

  it('terminates the tree immediately when the signal is already aborted', () => {
    const child = makeFakeChild()
    const signalTree = vi.fn()
    run(baseOpts({ signal: AbortSignal.abort() }), {
      spawn: fakeSpawn(child),
      signalTree,
      killGraceMs: 10,
      drainMs: 10
    })
    expect(signalTree).toHaveBeenCalledWith(child, 'SIGTERM')
  })

  it('resolves with an error message when the process fails to launch', async () => {
    const child = makeFakeChild()
    const p = run(baseOpts(), { spawn: fakeSpawn(child), signalTree: vi.fn(), drainMs: 10 })

    child.emit('error', new Error('spawn sandbox-exec ENOENT'))

    const res = await p
    expect(res.exitCode).toBeNull()
    expect(res.stderr).toContain('ENOENT')
    expect(res.stdout).toBe('')
  })
})
