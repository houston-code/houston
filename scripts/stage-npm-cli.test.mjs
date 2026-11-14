import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import nodeModule, { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { build } from 'esbuild'
import { bundleStartsFromLauncher, npmManifest, PACKAGE_NAME } from './stage-npm-cli.mjs'

const root = resolve(__dirname, '..')
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const LAUNCHER = join(root, 'packaging/npm/houston.cjs')
const { compileCacheDir } = createRequire(import.meta.url)(LAUNCHER)
/** module.enableCompileCache arrived in Node 22.1 (the launcher skips it before that), getCompileCacheDir in 22.8. */
const hasCompileCache =
  typeof nodeModule.enableCompileCache === 'function' && typeof nodeModule.getCompileCacheDir === 'function'

describe('npmManifest', () => {
  const manifest = npmManifest(rootPkg)

  it('publishes the scoped CLI package, never the private app', () => {
    expect(manifest.name).toBe(PACKAGE_NAME)
    expect(manifest.private).toBeUndefined()
  })

  it('tracks the root version, license, repository and Node floor', () => {
    expect(manifest.version).toBe(rootPkg.version)
    expect(manifest.license).toBe(rootPkg.license)
    expect(manifest.repository).toEqual(rootPkg.repository)
    expect(manifest.engines).toEqual({ node: rootPkg.engines.node })
  })

  it('installs the command as `houston` and ships only the launcher, the bundle and the Apache NOTICE', () => {
    expect(manifest.bin).toEqual({ houston: 'houston.cjs' })
    expect(manifest.files).toEqual(['houston.cjs', 'houston-cli.cjs', 'NOTICE'])
  })

  it('runs a bundle that predates the launcher directly', () => {
    const legacy = npmManifest(rootPkg, { launcher: false })
    expect(legacy.bin).toEqual({ houston: 'houston-cli.cjs' })
    expect(legacy.files).toEqual(['houston-cli.cjs', 'NOTICE'])
  })

  it('carries no dependencies or install-time scripts', () => {
    expect(manifest.dependencies).toBeUndefined()
    expect(manifest.scripts).toBeUndefined()
  })

  // Provenance is requested by the release workflow's --provenance flag instead: in
  // publishConfig it would make a publish from outside CI fail.
  it('publishes publicly, leaving provenance to the publishing command', () => {
    expect(manifest.publishConfig).toEqual({ access: 'public' })
  })

  it('refuses a non-release version', () => {
    expect(() => npmManifest({ ...rootPkg, version: '0.3.0-dev' })).toThrow(/non-release/)
    expect(() => npmManifest({ ...rootPkg, version: '0.9.0-rc.1' })).toThrow(/non-release/)
    expect(() => npmManifest({ ...rootPkg, version: undefined })).toThrow(/non-release/)
  })
})

describe('compileCacheDir (the npm launcher)', () => {
  it('uses the per-user cache dir the Homebrew and AUR wrappers use', () => {
    expect(compileCacheDir('darwin', { XDG_CACHE_HOME: '/x' }, '/home/a')).toBe(
      '/home/a/Library/Caches/houston/compile-cache'
    )
    expect(compileCacheDir('linux', { XDG_CACHE_HOME: '/x/cache' }, '/home/a')).toBe('/x/cache/houston/compile-cache')
    expect(compileCacheDir('linux', {}, '/home/a')).toBe('/home/a/.cache/houston/compile-cache')
    expect(compileCacheDir('win32', { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'C:\\Users\\a')).toBe(
      'C:\\Users\\a\\AppData\\Local\\houston\\compile-cache'
    )
  })

  it('ignores an empty or relative XDG_CACHE_HOME or LOCALAPPDATA instead of caching under the cwd', () => {
    for (const XDG_CACHE_HOME of ['', 'cache', './cache']) {
      expect(compileCacheDir('linux', { XDG_CACHE_HOME }, '/home/a')).toBe('/home/a/.cache/houston/compile-cache')
    }
    for (const LOCALAPPDATA of ['', 'AppData\\Local']) {
      expect(compileCacheDir('win32', { LOCALAPPDATA }, 'C:\\Users\\a')).toBe(
        'C:\\Users\\a\\AppData\\Local\\houston\\compile-cache'
      )
    }
  })

  it("leaves Node's default with no usable home directory", () => {
    for (const home of [undefined, '', 'relative/home']) {
      expect(compileCacheDir('darwin', {}, home)).toBeUndefined()
      expect(compileCacheDir('linux', { XDG_CACHE_HOME: '/x/cache' }, home)).toBeUndefined()
      expect(compileCacheDir('win32', {}, home)).toBeUndefined()
    }
    // LOCALAPPDATA alone is enough on Windows.
    expect(compileCacheDir('win32', { LOCALAPPDATA: 'D:\\Local' }, undefined)).toBe('D:\\Local\\houston\\compile-cache')
  })
})

/** An environment whose home and cache dirs sit under `base`, NODE_COMPILE_CACHE unset unless given. */
function userEnv(base, extra = {}) {
  const env = {
    ...process.env,
    HOME: join(base, 'home'),
    USERPROFILE: join(base, 'home'),
    XDG_CACHE_HOME: join(base, 'xdg-cache'),
    LOCALAPPDATA: join(base, 'local-app-data'),
    HOUSTON_DATA_DIR: join(base, 'profile'),
    NO_COLOR: '1',
    ...extra
  }
  if (!('NODE_COMPILE_CACHE' in extra)) delete env.NODE_COMPILE_CACHE
  return env
}

/** Where the launcher should put the cache for a userEnv(base) run on this platform. */
function expectedCacheDir(base) {
  if (process.platform === 'darwin') return join(base, 'home', 'Library', 'Caches', 'houston', 'compile-cache')
  if (process.platform === 'win32') return join(base, 'local-app-data', 'houston', 'compile-cache')
  return join(base, 'xdg-cache', 'houston', 'compile-cache')
}

function runNode(args, env) {
  const r = spawnSync(process.execPath, args, { env, encoding: 'utf8' })
  expect(r.status, r.stderr).toBe(0)
  return r.stdout
}

describe.skipIf(!hasCompileCache)('the npm launcher (stand-in bundle)', () => {
  let dir = ''
  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'houston-launcher-')))
    copyFileSync(LAUNCHER, join(dir, 'houston.cjs'))
    // Stands in for houston-cli.cjs: reports what the launcher set up before starting it.
    writeFileSync(
      join(dir, 'houston-cli.cjs'),
      "exports.startCli = () => process.stdout.write(JSON.stringify({ env: process.env.NODE_COMPILE_CACHE ?? null, cacheDir: require('node:module').getCompileCacheDir() ?? null, argv: process.argv.slice(2) }))\n"
    )
  })
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })
  const launch = (env, ...args) => JSON.parse(runNode([join(dir, 'houston.cjs'), ...args], env))

  it('turns the cache on in the per-user dir before starting the bundle, without exporting it to child processes', () => {
    const base = join(dir, 'fresh')
    const got = launch(userEnv(base), '-p', 'hi')
    expect(got.env).toBeNull()
    expect(got.cacheDir.startsWith(expectedCacheDir(base) + sep)).toBe(true)
    expect(got.argv).toEqual(['-p', 'hi'])
  })

  it('leaves a NODE_COMPILE_CACHE the caller set alone, including an empty one that turns caching off', () => {
    const base = join(dir, 'caller')
    const mine = join(base, 'mine')
    const custom = launch(userEnv(base, { NODE_COMPILE_CACHE: mine }))
    expect(custom.env).toBe(mine)
    expect(custom.cacheDir.startsWith(mine + sep)).toBe(true)
    expect(launch(userEnv(base, { NODE_COMPILE_CACHE: '' }))).toMatchObject({ env: '', cacheDir: null })
    expect(existsSync(expectedCacheDir(base))).toBe(false)
  })
})

describe('bundleStartsFromLauncher', () => {
  let dir = ''
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'houston-stage-'))
  })
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('tells a bundle that exports startCli from one that only starts as the main module', () => {
    const current = join(dir, 'current.cjs')
    const legacy = join(dir, 'legacy.cjs')
    writeFileSync(current, '#!/usr/bin/env node\nexports.startCli = () => {}\n')
    writeFileSync(legacy, "#!/usr/bin/env node\nif (require.main === module) console.log('ran')\n")
    expect(bundleStartsFromLauncher(current)).toBe(true)
    expect(bundleStartsFromLauncher(legacy)).toBe(false)
    expect(bundleStartsFromLauncher(join(dir, 'missing.cjs'))).toBe(false)
  })

  it('stages a bundle without startCli the way it always was, with no launcher', () => {
    const legacy = join(dir, 'houston-cli.cjs')
    writeFileSync(legacy, "#!/usr/bin/env node\nif (require.main === module) console.log('ran')\n")
    const out = join(dir, 'out')
    const manifest = join(dir, 'package.json')
    writeFileSync(manifest, JSON.stringify({ ...rootPkg, version: '1.2.3' }))
    runNode([join(root, 'scripts/stage-npm-cli.mjs'), '--cli', legacy, '--out', out, '--manifest', manifest], process.env)
    expect(JSON.parse(readFileSync(join(out, 'package.json'), 'utf8')).bin).toEqual({ houston: 'houston-cli.cjs' })
    expect(existsSync(join(out, 'houston.cjs'))).toBe(false)
  })
})

// The real thing: bundle the CLI the way scripts/build-cli.mjs does, stage the package
// with this script, and run `houston` the way npm's bin link does.
describe.skipIf(!hasCompileCache)('the staged npm package (real bundle)', () => {
  const VERSION = '1.2.3'
  let dir = ''
  let pkgDir = ''
  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'houston-npm-')))
    const cli = join(dir, 'houston-cli.cjs')
    await build({
      absWorkingDir: root,
      entryPoints: ['src/cli/index.ts'],
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'cjs',
      outfile: cli,
      banner: { js: '#!/usr/bin/env node' },
      define: { __HOUSTON_VERSION__: JSON.stringify(VERSION) },
      alias: { '@shared': join(root, 'src/shared') },
      external: ['supports-color'],
      logLevel: 'silent'
    })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ ...rootPkg, version: VERSION }))
    pkgDir = join(dir, 'npm-cli')
    runNode(
      [join(root, 'scripts/stage-npm-cli.mjs'), '--cli', cli, '--out', pkgDir, '--manifest', join(dir, 'package.json')],
      process.env
    )
  }, 120_000)
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('links `houston` to the launcher, shipped next to the bundle', () => {
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
    expect(manifest.bin).toEqual({ houston: 'houston.cjs' })
    for (const file of manifest.files) expect(existsSync(join(pkgDir, file)), file).toBe(true)
  })

  it('answers --version and runs the program, filling the per-user compile cache', () => {
    const base = join(dir, 'user')
    const env = userEnv(base)
    expect(runNode([join(pkgDir, 'houston.cjs'), '--version'], env)).toBe(`${VERSION}\n`)
    expect(readdirSync(expectedCacheDir(base), { recursive: true }).length).toBeGreaterThan(0)
    // `providers` loads the whole program (store, providers), not just the entry.
    expect(runNode([join(pkgDir, 'houston.cjs'), 'providers'], env)).toContain('Configured providers:')
  }, 30_000)

  it('leaves a NODE_COMPILE_CACHE the caller set alone', () => {
    const base = join(dir, 'caller')
    const mine = join(base, 'mine')
    const env = userEnv(base, { NODE_COMPILE_CACHE: mine })
    expect(runNode([join(pkgDir, 'houston.cjs'), '--version'], env)).toBe(`${VERSION}\n`)
    expect(readdirSync(mine, { recursive: true }).length).toBeGreaterThan(0)
    expect(existsSync(expectedCacheDir(base))).toBe(false)
  }, 30_000)
})
