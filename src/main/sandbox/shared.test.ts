import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join, sep, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import {
  augmentPath,
  bundledNodeGypVersion,
  npmRootOnPath,
  readsPackageConfigEnv,
  nvmDefaultBin,
  versionManagerDirs,
  type PathFs,
  CappedOutput,
  clampToolResult,
  pkgCacheDir,
  planKill,
  resolvePosixShell,
  runWithBackend,
  spawnWithBackend,
  sandboxEnv,
  OFFLINE_FAIL_FAST_ENV,
  signalProcessTree,
  windowsKillCommands
} from './shared'
import { win32 } from 'node:path'
import type { SandboxBackend, SandboxRunOptions, SandboxSpawnOptions } from './contract'

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

  it('adds version-manager dirs ahead of Homebrew, after the inherited PATH', () => {
    const fsx = fakeFs({
      '/Users/me/.nvm/versions/node': ['v20.1.0', 'v22.3.0'],
      '/Users/me/.nvm/alias/default': '22'
    })
    const out = augmentPath({ PATH: minimalPath, HOME: '/Users/me' }, () => true, 'darwin', fsx).split(':')
    expect(out.slice(0, 4)).toEqual(minimalPath.split(':'))
    const nvm = out.indexOf('/Users/me/.nvm/versions/node/v22.3.0/bin')
    expect(nvm).toBeGreaterThan(3)
    expect(nvm).toBeLessThan(out.indexOf('/opt/homebrew/bin'))
    expect(out).toContain('/Users/me/.volta/bin')
    expect(out).toContain('/Users/me/.cargo/bin')
    expect(new Set(out).size).toBe(out.length)
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

  it('keeps a multibyte character intact when the head budget ends inside it', () => {
    // 'é' is two bytes; a 4-byte head ends after its first byte. Nothing is dropped,
    // so the output must read exactly as written, not with replacement characters.
    const cap = new CappedOutput(4, 8)
    cap.push(Buffer.from('café ok'))
    expect(cap.droppedBytes).toBe(0)
    expect(cap.toString()).toBe('café ok')
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

describe('pkgCacheDir', () => {
  it('falls back to os.tmpdir() when TMPDIR is empty (absolute, not relative)', () => {
    const cache = pkgCacheDir({ TMPDIR: '' } as NodeJS.ProcessEnv)
    // `??` would keep the empty string and yield a relative "houston-pkg-cache" that
    // resolves against the child's cwd (the workspace); `||` falls back to tmpdir().
    expect(isAbsolute(cache)).toBe(true)
    expect(cache).toBe(join(tmpdir(), 'houston-pkg-cache'))
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
    const env = sandboxEnv({ PATH: '/usr/bin', HOME: '/Users/me', TMPDIR: '/tmp' }, { nodeGypVersion: () => '12.4.0' })
    const cache = pkgCacheDir({ TMPDIR: '/tmp' })
    expect(env.npm_package_config_node_gyp_devdir).toBe(`${cache}${sep}node-gyp`)
    expect(env.npm_package_config_node_gyp_devdir).not.toMatch(/Users[/\\]me/) // not $HOME: that's the EPERM we fix
  })

  it("leaves out npm_config_devdir, which npm 11+ warns about, when node-gyp reads the package-config spelling", () => {
    const env = sandboxEnv({ PATH: '/usr/bin', TMPDIR: '/tmp' }, { nodeGypVersion: () => '11.4.0' })
    expect(env).not.toHaveProperty('npm_config_devdir')
  })

  it('keeps npm_config_devdir for a node-gyp older than 11.4, or one it cannot identify', () => {
    const cache = pkgCacheDir({ TMPDIR: '/tmp' })
    for (const version of ['11.2.0', '10.0.1', null]) {
      const env = sandboxEnv({ PATH: '/usr/bin', TMPDIR: '/tmp' }, { nodeGypVersion: () => version })
      expect(env.npm_config_devdir).toBe(`${cache}${sep}node-gyp`)
      expect(env.npm_package_config_node_gyp_devdir).toBe(`${cache}${sep}node-gyp`)
    }
  })

  it('sends no npm_config_ key the npm on PATH does not define, beyond the old node-gyp fallback', () => {
    // npm 11+ prints "Unknown env config" on every command for an npm_config_ key it
    // doesn't define, and says it will become an error. Checked against the real npm.
    const base = { PATH: process.env.PATH, TMPDIR: '/tmp' }
    const root = npmRootOnPath(augmentPath(base))
    if (process.env.CI) expect(root).not.toBeNull()
    if (!root) return
    const require = createRequire(import.meta.url)
    const { definitions } = require(join(root, 'node_modules', '@npmcli', 'config', 'lib', 'definitions')) as {
      definitions: Record<string, unknown>
    }
    const env = sandboxEnv(base, { offline: true })
    const legacyGyp = !readsPackageConfigEnv(bundledNodeGypVersion(augmentPath(base)))
    const unknown = Object.keys(env)
      .filter((k) => /^npm_config_/i.test(k))
      .map((k) => k.slice('npm_config_'.length).replace(/_/g, '-').toLowerCase())
      .filter((name) => !(name in definitions) && !(legacyGyp && name === 'devdir'))
    expect(unknown).toEqual([])
  })

  describe('node-gyp detection', () => {
    let root: string
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'houston-npm-'))
    })
    afterEach(() => rmSync(root, { recursive: true, force: true }))

    function posixNpm(gypVersion: string | null): string {
      const npmDir = join(root, 'lib', 'node_modules', 'npm')
      mkdirSync(join(npmDir, 'bin'), { recursive: true })
      writeFileSync(join(npmDir, 'bin', 'npm-cli.js'), '')
      if (gypVersion) {
        mkdirSync(join(npmDir, 'node_modules', 'node-gyp'), { recursive: true })
        writeFileSync(join(npmDir, 'node_modules', 'node-gyp', 'package.json'), JSON.stringify({ version: gypVersion }))
      }
      mkdirSync(join(root, 'bin'))
      symlinkSync(join('..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(root, 'bin', 'npm'))
      return join(root, 'bin')
    }

    it.skipIf(process.platform === 'win32')('reads the node-gyp bundled with the first npm on PATH', () => {
      const bin = posixNpm('12.4.0')
      expect(npmRootOnPath(`/nonexistent:${bin}`, 'darwin')).toBe(realpathSync(join(root, 'lib', 'node_modules', 'npm')))
      expect(bundledNodeGypVersion(`/nonexistent:${bin}`, 'darwin')).toBe('12.4.0')
    })

    it.skipIf(process.platform === 'win32')('is null when npm bundles no node-gyp, or npm is a shim', () => {
      const bin = posixNpm(null)
      expect(bundledNodeGypVersion(bin, 'darwin')).toBeNull()
      const shimDir = join(root, 'shim')
      mkdirSync(shimDir)
      writeFileSync(join(shimDir, 'npm'), '#!/bin/sh\n')
      expect(npmRootOnPath(shimDir, 'darwin')).toBeNull()
      expect(bundledNodeGypVersion('/nonexistent', 'darwin')).toBeNull()
    })

    it('reads the Windows layout: npm.cmd next to node_modules/npm', () => {
      writeFileSync(join(root, 'npm.cmd'), '')
      const gyp = join(root, 'node_modules', 'npm', 'node_modules', 'node-gyp')
      mkdirSync(gyp, { recursive: true })
      writeFileSync(join(gyp, 'package.json'), JSON.stringify({ version: '11.4.2' }))
      expect(bundledNodeGypVersion(`C:\\nowhere;${root}`, 'win32')).toBe('11.4.2')
    })

    it('tells which node-gyp versions read npm_package_config_node_gyp_<key>', () => {
      expect(readsPackageConfigEnv('11.4.0')).toBe(true)
      expect(readsPackageConfigEnv('11.10.1')).toBe(true)
      expect(readsPackageConfigEnv('12.0.0')).toBe(true)
      expect(readsPackageConfigEnv('11.3.9')).toBe(false)
      expect(readsPackageConfigEnv('10.9.0')).toBe(false)
      expect(readsPackageConfigEnv('not-a-version')).toBe(false)
      expect(readsPackageConfigEnv(null)).toBe(false)
    })
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

  describe('offline fail-fast', () => {
    const base = { PATH: '/usr/bin', HOME: '/Users/me', TMPDIR: '/tmp' }

    it('cuts npm, pip, and cargo retries when the sandbox blocks the network', () => {
      const env = sandboxEnv(base, { offline: true })
      expect(env.npm_config_fetch_retries).toBe('0')
      expect(env.PIP_RETRIES).toBe('1') // one retry: its warning is the only line naming the network error
      expect(env.PIP_TIMEOUT).toBe('5')
      expect(env.CARGO_NET_RETRY).toBe('0')
    })

    it('leaves npm retry timeouts alone (a max below npm\'s default min makes npm refuse to run)', () => {
      const env = sandboxEnv(base, { offline: true })
      expect(env.npm_config_fetch_retry_maxtimeout).toBeUndefined()
      expect(env.npm_config_fetch_retry_mintimeout).toBeUndefined()
    })

    it('changes nothing about retries when network is available (the default)', () => {
      for (const env of [sandboxEnv(base), sandboxEnv(base, { offline: false })]) {
        for (const name of Object.keys(OFFLINE_FAIL_FAST_ENV)) expect(env[name]).toBeUndefined()
      }
    })

    it('keeps a user-exported retry setting when network is available', () => {
      const env = sandboxEnv({ ...base, PIP_RETRIES: '10', npm_config_fetch_retries: '4' })
      expect(env.PIP_RETRIES).toBe('10')
      expect(env.npm_config_fetch_retries).toBe('4')
    })

    it('overrides a user-exported retry setting offline, where retrying cannot help', () => {
      const env = sandboxEnv({ ...base, PIP_RETRIES: '10', npm_config_fetch_retries: '4' }, { offline: true })
      expect(env.PIP_RETRIES).toBe('1')
      expect(env.npm_config_fetch_retries).toBe('0')
    })
  })

  describe('Python bytecode cache', () => {
    const base = { PATH: '/usr/bin', HOME: '/Users/me', TMPDIR: '/tmp' }

    it("points it into the writable cache on macOS (Apple's python3 defaults under ~/Library/Caches)", () => {
      const env = sandboxEnv(base, { platform: 'darwin' })
      expect(env.PYTHONPYCACHEPREFIX).toBe(`${pkgCacheDir({ TMPDIR: '/tmp' })}${sep}pycache`)
      expect(env.PYTHONPYCACHEPREFIX).not.toMatch(/Users[/\\]me/)
    })

    it('leaves it alone elsewhere, where __pycache__ sits beside the source', () => {
      expect(sandboxEnv(base, { platform: 'linux' }).PYTHONPYCACHEPREFIX).toBeUndefined()
      expect(sandboxEnv(base, { platform: 'win32' }).PYTHONPYCACHEPREFIX).toBeUndefined()
    })
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
    shellSyntax: 'posix',
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

  it('adds the offline fail-fast env only when a confining backend blocks the network', () => {
    const envFor = (sandboxed: boolean, allowNetwork: boolean): NodeJS.ProcessEnv => {
      const spawn = fakeSpawn(makeFakeChild())
      runWithBackend(fakeBackend(sandboxed), baseOpts({ allowNetwork, env: { PATH: '/usr/bin' } }), {
        spawn,
        signalTree: vi.fn(),
        drainMs: 20
      })
      return spawn.calls[0].options.env
    }
    expect(envFor(true, false).npm_config_fetch_retries).toBe('0')
    // Network granted: retries stay at the tools' own defaults.
    expect(envFor(true, true).npm_config_fetch_retries).toBeUndefined()
    // A backend that can't block the network: the command really has it, so no change.
    expect(envFor(false, false).npm_config_fetch_retries).toBeUndefined()
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

describe('spawnWithBackend — offline fail-fast env', () => {
  const printRetries = (confinesNetwork: boolean): SandboxBackend => ({
    id: confinesNetwork ? 'seatbelt' : 'none',
    sandboxed: confinesNetwork,
    confinesNetwork,
    supportsSession: true,
    shellSyntax: 'posix',
    buildLaunch: () => ({
      file: process.execPath,
      args: ['-e', 'process.stdout.write(process.env.npm_config_fetch_retries ?? "unset")'],
      detached: false,
      windowsHide: true,
      supportsSession: true
    })
  })

  async function retriesSeen(confinesNetwork: boolean, allowNetwork: boolean): Promise<string> {
    const { child } = spawnWithBackend(printRetries(confinesNetwork), {
      command: 'noop',
      cwd: process.cwd(),
      workspace: process.cwd(),
      allowNetwork,
      // A controlled base env: `npm test` exports npm_config_* vars of its own.
      env: { PATH: process.env.PATH }
    })
    let out = ''
    child.stdout?.on('data', (c: Buffer) => (out += c.toString()))
    await new Promise<void>((resolve) => child.once('close', () => resolve()))
    return out
  }

  it('reaches a background shell only when its network is blocked', async () => {
    expect(await retriesSeen(true, false)).toBe('0')
    expect(await retriesSeen(true, true)).toBe('unset')
    expect(await retriesSeen(false, false)).toBe('unset')
  })
})

describe('spawnWithBackend — env overrides', () => {
  it("override the sandbox's cache redirects, and the launch's own variables override them", async () => {
    const backend: SandboxBackend = {
      id: 'none',
      sandboxed: false,
      confinesNetwork: false,
      supportsSession: true,
      shellSyntax: 'posix',
      buildLaunch: () => ({
        file: process.execPath,
        args: ['-e', 'process.stdout.write(`${process.env.GOMODCACHE}|${process.env.CARGO_HOME}|${process.env.LAUNCH}`)'],
        env: { LAUNCH: 'launch' },
        detached: false,
        windowsHide: true,
        supportsSession: true
      })
    }
    const { child } = spawnWithBackend(backend, {
      command: 'noop',
      cwd: process.cwd(),
      workspace: process.cwd(),
      allowNetwork: false,
      env: { PATH: process.env.PATH, TMPDIR: '/t' },
      envOverrides: { GOMODCACHE: '/user/mod', LAUNCH: 'mine' }
    })
    let out = ''
    child.stdout?.on('data', (c: Buffer) => (out += c.toString()))
    await new Promise<void>((resolve) => child.once('close', () => resolve()))
    expect(out).toBe(`/user/mod|${join('/t', 'houston-pkg-cache', 'cargo')}|launch`)
  })
})

describe('spawnWithBackend — abort listener cleanup', () => {
  it('removes its abort listener once the child exits', async () => {
    const ac = new AbortController()
    const removeSpy = vi.spyOn(ac.signal, 'removeEventListener')
    const backend: SandboxBackend = {
      id: 'none',
      sandboxed: false,
      confinesNetwork: false,
      supportsSession: true,
      shellSyntax: 'posix',
      // A real, immediately-exiting process (spawnWithBackend uses the real spawn).
      buildLaunch: () => ({
        file: process.execPath,
        args: ['-e', '0'],
        detached: false,
        windowsHide: false,
        supportsSession: true
      })
    }
    const opts: SandboxSpawnOptions = {
      command: 'noop',
      cwd: process.cwd(),
      workspace: process.cwd(),
      allowNetwork: false,
      signal: ac.signal
    }
    const { child } = spawnWithBackend(backend, opts)
    await new Promise<void>((resolve) => child.once('exit', () => resolve()))
    // The internal exit handler (which removes the listener) is also on 'exit'; let it run.
    await new Promise((r) => setImmediate(r))
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function))
  })
})

/** A PathFs over a literal map: string values are files, arrays are directories. */
function fakeFs(tree: Record<string, string | string[]>): PathFs {
  return {
    readFile: (p) => (typeof tree[p] === 'string' ? (tree[p] as string) : null),
    readdir: (p) => (Array.isArray(tree[p]) ? (tree[p] as string[]) : [])
  }
}

describe('nvmDefaultBin', () => {
  const dir = '/h/.nvm'
  const versions = { [`${dir}/versions/node`]: ['v18.20.8', 'v22.13.0', 'v22.22.3', 'v20.19.0', 'junk'] }
  const bin = (v: string): string => `${dir}/versions/node/${v}/bin`

  it('returns null when nvm has no installed versions', () => {
    expect(nvmDefaultBin(dir, fakeFs({}))).toBeNull()
  })

  it('resolves a major-version alias to the newest matching install', () => {
    expect(nvmDefaultBin(dir, fakeFs({ ...versions, [`${dir}/alias/default`]: '22\n' }))).toBe(
      bin('v22.22.3')
    )
  })

  it('resolves an exact version alias', () => {
    expect(nvmDefaultBin(dir, fakeFs({ ...versions, [`${dir}/alias/default`]: 'v22.13.0' }))).toBe(
      bin('v22.13.0')
    )
  })

  it('follows lts alias chains', () => {
    const fsx = fakeFs({
      ...versions,
      [`${dir}/alias/default`]: 'lts/*',
      [`${dir}/alias/lts/*`]: 'lts/iron',
      [`${dir}/alias/lts/iron`]: 'v20.19.0'
    })
    expect(nvmDefaultBin(dir, fsx)).toBe(bin('v20.19.0'))
  })

  it('falls back to the newest install for node/stable, a missing alias, or a bad one', () => {
    for (const alias of ['node', 'stable', '', '../../etc/passwd', 'v99']) {
      expect(nvmDefaultBin(dir, fakeFs({ ...versions, [`${dir}/alias/default`]: alias }))).toBe(
        bin('v22.22.3')
      )
    }
  })

  it('does not loop forever on a self-referencing alias', () => {
    const fsx = fakeFs({ ...versions, [`${dir}/alias/default`]: 'a', [`${dir}/alias/a`]: 'a' })
    expect(nvmDefaultBin(dir, fsx)).toBe(bin('v22.22.3'))
  })
})

describe('versionManagerDirs', () => {
  it('is empty without HOME', () => {
    expect(versionManagerDirs({}, 'darwin', fakeFs({}))).toEqual([])
  })

  it('honors NVM_DIR and FNM_DIR, and adds the macOS fnm dir only on darwin', () => {
    const fsx = fakeFs({ '/custom/nvm/versions/node': ['v22.0.0'] })
    const env = { HOME: '/h', NVM_DIR: '/custom/nvm', FNM_DIR: '/custom/fnm' }
    const mac = versionManagerDirs(env, 'darwin', fsx)
    expect(mac).toContain('/custom/nvm/versions/node/v22.0.0/bin')
    expect(mac).toContain('/custom/fnm/aliases/default/bin')
    expect(mac).toContain('/h/Library/Application Support/fnm/aliases/default/bin')
    expect(versionManagerDirs(env, 'linux', fsx)).not.toContain(
      '/h/Library/Application Support/fnm/aliases/default/bin'
    )
  })
})
