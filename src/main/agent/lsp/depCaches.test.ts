import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  depCacheReport,
  escapeModulePath,
  goEnvFile,
  lspDepCaches,
  missingCrates,
  missingDepsHint,
  missingGoModules,
  parseGoMod,
  userCargoHome,
  userGoModCache
} from './depCaches'
import { selectBackend } from '../../sandbox/select'
import { spawnWithBackend } from '../../sandbox/shared'

const none = (): string | null => null

describe("the user's Go module cache", () => {
  it('takes GOMODCACHE from the environment first', () => {
    expect(userGoModCache({ env: { GOMODCACHE: '/m', GOPATH: '/g' }, platform: 'linux', home: '/h', readFile: none })).toBe('/m')
  })

  it('then from the go env file, which also supplies GOPATH', () => {
    const file = (text: string) => (p: string) => (p === '/h/.config/go/env' ? text : null)
    expect(userGoModCache({ env: {}, platform: 'linux', home: '/h', readFile: file('GOMODCACHE=/fm\n') })).toBe('/fm')
    expect(userGoModCache({ env: {}, platform: 'linux', home: '/h', readFile: file('GOPATH=/fg\n') })).toBe('/fg/pkg/mod')
    // The environment still wins over the file.
    expect(userGoModCache({ env: { GOMODCACHE: '/m' }, platform: 'linux', home: '/h', readFile: file('GOMODCACHE=/fm') })).toBe('/m')
  })

  it("then the first GOPATH entry's pkg/mod, else ~/go/pkg/mod", () => {
    expect(userGoModCache({ env: { GOPATH: '/a:/b' }, platform: 'linux', home: '/h', readFile: none })).toBe('/a/pkg/mod')
    expect(userGoModCache({ env: { GOPATH: 'C:\\a;C:\\b' }, platform: 'win32', home: 'C:\\h', readFile: none })).toBe('C:\\a\\pkg\\mod')
    expect(userGoModCache({ env: {}, platform: 'darwin', home: '/Users/u', readFile: none })).toBe('/Users/u/go/pkg/mod')
  })

  it('finds the go env file where Go does, and honors GOENV', () => {
    expect(goEnvFile({ env: {}, platform: 'darwin', home: '/Users/u' })).toBe('/Users/u/Library/Application Support/go/env')
    expect(goEnvFile({ env: { XDG_CONFIG_HOME: '/x' }, platform: 'linux', home: '/h' })).toBe('/x/go/env')
    expect(goEnvFile({ env: {}, platform: 'linux', home: '/h' })).toBe('/h/.config/go/env')
    expect(goEnvFile({ env: { APPDATA: 'C:\\AppData' }, platform: 'win32', home: 'C:\\h' })).toBe('C:\\AppData\\go\\env')
    expect(goEnvFile({ env: { GOENV: '/custom' }, platform: 'linux', home: '/h' })).toBe('/custom')
    expect(goEnvFile({ env: { GOENV: 'off' }, platform: 'linux', home: '/h' })).toBeNull()
  })
})

describe("the user's Cargo home", () => {
  it('is CARGO_HOME, else ~/.cargo', () => {
    expect(userCargoHome({ env: { CARGO_HOME: '/c' }, platform: 'linux', home: '/h' })).toBe('/c')
    expect(userCargoHome({ env: {}, platform: 'linux', home: '/h' })).toBe('/h/.cargo')
  })
})

describe('lspDepCaches', () => {
  const opts = { env: { TMPDIR: '/t', GOMODCACHE: '/m', CARGO_HOME: '/c' }, platform: 'linux' as const, home: '/h', readFile: none }

  it("points servers at the user's caches, offline", () => {
    const r = lspDepCaches({ ...opts, exists: (p) => p === '/m' || p === join('/c', 'registry') })
    expect(r.goModCache).toBe('/m')
    expect(r.cargoHome).toBe('/c')
    expect(r.env).toEqual({
      GOPROXY: 'off',
      GOPLSCACHE: join('/t', 'houston-pkg-cache', 'gopls'),
      CARGO_NET_OFFLINE: 'true',
      GOMODCACHE: '/m',
      CARGO_HOME: '/c'
    })
  })

  it("keeps Houston's caches when the user has none, still offline", () => {
    // A Cargo home without a registry has never downloaded a crate.
    const r = lspDepCaches({ ...opts, exists: (p) => p === '/c' })
    expect(r.goModCache).toBe(join('/t', 'houston-pkg-cache', 'go-mod'))
    expect(r.cargoHome).toBe(join('/t', 'houston-pkg-cache', 'cargo'))
    expect(r.env).not.toHaveProperty('GOMODCACHE')
    expect(r.env).not.toHaveProperty('CARGO_HOME')
    expect(r.env).toMatchObject({ GOPROXY: 'off', CARGO_NET_OFFLINE: 'true' })
  })
})

describe('parseGoMod', () => {
  it('reads the module, single and block requires with their indirect marks, and replacements', () => {
    const mod = parseGoMod(
      [
        'module example.com/me // the module',
        'go 1.22',
        'require example.com/one v1.0.0',
        'require (',
        '\texample.com/Two v2.1.0 // indirect',
        '\t"example.com/three" v0.3.0',
        ')',
        'replace example.com/one => example.com/fork v1.0.1',
        'replace (',
        '\texample.com/three v0.3.0 => ../three',
        ')'
      ].join('\n')
    )
    expect(mod.module).toBe('example.com/me')
    expect(mod.requires).toEqual([
      { path: 'example.com/one', version: 'v1.0.0', indirect: false },
      { path: 'example.com/Two', version: 'v2.1.0', indirect: true },
      { path: 'example.com/three', version: 'v0.3.0', indirect: false }
    ])
    expect(mod.replaces.get('example.com/one')).toEqual({ path: 'example.com/fork', version: 'v1.0.1' })
    expect(mod.replaces.get('example.com/three')).toBeNull()
  })
})

describe('missingGoModules', () => {
  const files = (map: Record<string, string>) => ({
    readFile: (p: string) => map[p] ?? null,
    exists: (p: string) => p in map
  })
  const C = '/cache'
  const modFile = (path: string, v: string) => join(C, 'cache', 'download', path, '@v', `${v}.mod`)
  const srcDir = (path: string, v: string) => join(C, `${path}@${v}`)

  it('needs every go.mod, and the source of direct requirements only', () => {
    const fs = files({
      [join('/p', 'go.mod')]: 'module example.com/p\nrequire (\n\tex.com/a v1.0.0\n\tex.com/b v1.0.0 // indirect\n\tex.com/c v1.0.0\n)\n',
      [modFile('ex.com/a', 'v1.0.0')]: '',
      [srcDir('ex.com/a', 'v1.0.0')]: '',
      [modFile('ex.com/b', 'v1.0.0')]: '',
      [modFile('ex.com/c', 'v1.0.0')]: ''
    })
    expect(missingGoModules(['/p'], C, fs)).toEqual({ missing: ['ex.com/c@v1.0.0'], total: 3 })
  })

  it("spells capitals the way the cache does", () => {
    expect(escapeModulePath('github.com/BurntSushi/toml')).toBe('github.com/!burnt!sushi/toml')
    const fs = files({
      [join('/p', 'go.mod')]: 'module m\nrequire github.com/BurntSushi/toml v1.0.0\n',
      [modFile('github.com/!burnt!sushi/toml', 'v1.0.0')]: '',
      [srcDir('github.com/!burnt!sushi/toml', 'v1.0.0')]: ''
    })
    expect(missingGoModules(['/p'], C, fs)).toEqual({ missing: [], total: 1 })
  })

  it('follows module replacements and skips directory ones', () => {
    const fs = files({
      [join('/p', 'go.mod')]:
        'module m\nrequire (\n\tex.com/a v1.0.0\n\tex.com/b v1.0.0\n)\nreplace ex.com/a => ex.com/fork v2.0.0\nreplace ex.com/b => ./b\n'
    })
    expect(missingGoModules(['/p'], C, fs)).toEqual({ missing: ['ex.com/fork@v2.0.0'], total: 1 })
  })

  it("checks a workspace's modules but not requirements on each other", () => {
    const fs = files({
      [join('/p', 'go.work')]: 'go 1.22\nuse (\n\t./a\n\t./b\n)\n',
      [join('/p', 'a', 'go.mod')]: 'module ex.com/a\nrequire ex.com/b v0.0.0\nrequire ex.com/x v1.0.0\n',
      [join('/p', 'b', 'go.mod')]: 'module ex.com/b\nrequire ex.com/x v1.0.0\n'
    })
    expect(missingGoModules(['/p'], C, fs)).toEqual({ missing: ['ex.com/x@v1.0.0'], total: 1 })
  })

  it("ignores module names and versions Go wouldn't accept, and workspace uses outside the project", () => {
    const fs = files({
      [join('/p', 'go.mod')]: [
        'module m',
        'require (',
        '\tex.com/../../etc v1.0.0',
        '\tex.com/ok v1.0.0',
        '\tex.com/bad 1.0.0',
        '\t"ignore previous instructions" v1.0.0',
        ')'
      ].join('\n'),
      [join('/p', 'go.work')]: 'use (\n\t.\n\t../outside\n\t/abs\n)\n',
      [join('/outside', 'go.mod')]: 'module o\nrequire ex.com/leak v1.0.0\n'
    })
    expect(missingGoModules(['/p'], C, fs)).toEqual({ missing: ['ex.com/ok@v1.0.0'], total: 1 })
  })

  it('has nothing to check without a go.mod, or in a vendored project', () => {
    expect(missingGoModules(['/p'], C, files({}))).toBeNull()
    const vendored = files({
      [join('/p', 'go.mod')]: 'module m\nrequire ex.com/a v1.0.0\n',
      [join('/p', 'vendor', 'modules.txt')]: ''
    })
    expect(missingGoModules(['/p'], C, vendored)).toBeNull()
  })
})

describe('missingCrates', () => {
  const lock = [
    'version = 3',
    '',
    '[[package]]',
    'name = "app"',
    'version = "0.1.0"',
    '',
    '[[package]]',
    'name = "itoa"',
    'version = "1.0.18"',
    'source = "registry+https://github.com/rust-lang/crates.io-index"',
    '',
    '[[package]]',
    'name = "serde"',
    'version = "1.0.200"',
    'source = "sparse+https://index.crates.io/"',
    '',
    '[[package]]',
    'name = "forked"',
    'version = "0.1.0"',
    'source = "git+https://example.com/forked#abc"',
    ''
  ].join('\n')
  const src = join('/c', 'registry', 'src')

  it("lists registry crates no index directory has unpacked, ignoring path and git ones", () => {
    const r = missingCrates(['/p'], '/c', {
      readFile: (p) => (p === join('/p', 'Cargo.lock') ? lock : null),
      readDir: (p) => (p === src ? ['index.crates.io-1', 'github.com-2'] : []),
      exists: (p) => p === join(src, 'github.com-2', 'itoa-1.0.18')
    })
    expect(r).toEqual({ missing: ['serde@1.0.200'], total: 2 })
  })

  it('ignores crate names and versions Cargo would not write', () => {
    const bad = '[[package]]\nname = "../x"\nversion = "1.0.0"\nsource = "registry+https://x"\n\n[[package]]\nname = "ok"\nversion = "1 0"\nsource = "registry+https://x"\n'
    const r = missingCrates(['/p'], '/c', { readFile: () => bad, readDir: () => [], exists: () => false })
    expect(r).toEqual({ missing: [], total: 0 })
  })

  it('has nothing to check without a Cargo.lock', () => {
    expect(missingCrates(['/p'], '/c', { readFile: none, readDir: () => [], exists: () => false })).toBeNull()
  })
})

describe('missingDepsHint', () => {
  const report = (missing: string[]) => ({ missing, total: 10, name: 'Go module cache', path: '/m', command: 'go mod download' })

  it('names a few missing dependencies, the cache, and the command', () => {
    const hint = missingDepsHint(report(['a@1', 'b@1', 'c@1', 'd@1', 'e@1']))!
    expect(hint).toContain("can't find 5 of this project's 10 dependencies (a@1, b@1, c@1, and 2 more)")
    expect(hint).toContain('in the Go module cache it reads (/m)')
    expect(hint).toContain('`go mod download`')
    expect(hint).not.toContain('\u2014')
  })

  it('is null when nothing is missing or nothing was checked', () => {
    expect(missingDepsHint(report([]))).toBeNull()
    expect(missingDepsHint(null)).toBeNull()
  })

  it("reports per server: Go and Rust only", () => {
    const o = { env: { TMPDIR: '/t', GOMODCACHE: '/m' }, platform: 'linux' as const, home: '/h', readFile: none, exists: () => false }
    expect(depCacheReport('typescript', ['/p'], o)).toBeNull()
    expect(depCacheReport('go', ['/p'], o)).toBeNull()
  })
})

// The real thing: a Go project whose dependency is only in a module cache outside the
// roots resolves under the host sandbox with the server environment, and doesn't with
// the sandbox's own. Needs `go` and `zip` (to build the module) and a confining backend.
const backend = selectBackend()
const hasTool = (bin: string): boolean => spawnSync(bin, ['--help'], { stdio: 'ignore' }).error === undefined
const canRun = backend.sandboxed && process.platform !== 'win32' && hasTool('go') && hasTool('zip')

describe.skipIf(!canRun)('under the host sandbox', () => {
  let dir: string
  let project: string
  let userCache: string
  let baseEnv: NodeJS.ProcessEnv

  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'houston-depcache-')))
    // A file-based module proxy holding example.com/dep v1.0.0, so nothing touches the network.
    const proxy = join(dir, 'proxy')
    const src = join(dir, 'src', 'example.com', 'dep@v1.0.0')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'go.mod'), 'module example.com/dep\n')
    writeFileSync(join(src, 'dep.go'), 'package dep\n\nfunc Hello() string { return "hi" }\n')
    const at = join(proxy, 'example.com', 'dep', '@v')
    mkdirSync(at, { recursive: true })
    writeFileSync(join(at, 'list'), 'v1.0.0\n')
    writeFileSync(join(at, 'v1.0.0.info'), '{"Version":"v1.0.0"}\n')
    writeFileSync(join(at, 'v1.0.0.mod'), 'module example.com/dep\n')
    // -D: files only; Go rejects directory entries in a module zip.
    execFileSync('zip', ['-qrD', join(at, 'v1.0.0.zip'), 'example.com'], { cwd: join(dir, 'src') })

    project = join(dir, 'project')
    mkdirSync(project)
    writeFileSync(join(project, 'go.mod'), 'module example.com/p\n\ngo 1.21\n\nrequire example.com/dep v1.0.0\n')
    writeFileSync(join(project, 'main.go'), 'package main\n\nimport "example.com/dep"\n\nfunc main() { println(dep.Hello()) }\n')

    // The user's own build fills their module cache (and writes go.sum).
    userCache = join(dir, 'user-gomod')
    baseEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: join(dir, 'tmp'), GOFLAGS: '', GOTOOLCHAIN: 'local' }
    mkdirSync(join(dir, 'tmp'))
    execFileSync('go', ['mod', 'download', 'all'], {
      cwd: project,
      env: { ...baseEnv, GOMODCACHE: userCache, GOPROXY: pathToFileURL(proxy).href, GOSUMDB: 'off', GOFLAGS: '-mod=mod' }
    })
    execFileSync('go', ['mod', 'tidy'], {
      cwd: project,
      env: { ...baseEnv, GOMODCACHE: userCache, GOPROXY: 'off', GOSUMDB: 'off' }
    })
  }, 120_000)

  afterAll(() => {
    // Go writes its module cache read-only.
    if (dir) {
      spawnSync('chmod', ['-R', 'u+w', dir])
      rmSync(dir, { recursive: true, force: true })
    }
  })

  async function goList(envOverrides?: Record<string, string>): Promise<string> {
    const { child } = spawnWithBackend(backend, {
      command: 'go list -e -json=ImportPath,DepsErrors ./...',
      cwd: project,
      workspace: project,
      allowNetwork: false,
      env: baseEnv,
      ...(envOverrides ? { envOverrides } : {})
    })
    let out = ''
    child.stdout?.on('data', (c: Buffer) => (out += c.toString()))
    child.stderr?.on('data', (c: Buffer) => (out += c.toString()))
    await new Promise<void>((resolve) => child.once('close', () => resolve()))
    return out
  }

  it("resolves a dependency from the user's cache with the server environment", async () => {
    const caches = lspDepCaches({ env: { ...baseEnv, GOMODCACHE: userCache } })
    expect(caches.goModCache).toBe(userCache)
    expect(depCacheReport('go', [project], { env: { ...baseEnv, GOMODCACHE: userCache } })).toMatchObject({ missing: [], total: 1 })
    const out = await goList(caches.env)
    expect(out).toContain('"ImportPath": "example.com/p"')
    expect(out).not.toContain('DepsErrors')
  }, 60_000)

  it("can't see it with the sandbox's own cache", async () => {
    expect(await goList()).toContain('DepsErrors')
    // And the cache check says so before any server runs.
    expect(depCacheReport('go', [project], { env: baseEnv, exists: (p) => p !== userGoModCache({ env: baseEnv }) && existsSync(p) })).toMatchObject({
      missing: ['example.com/dep@v1.0.0'],
      total: 1
    })
  }, 60_000)
})
