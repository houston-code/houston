import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { assertRunsFromLauncher, npmManifest, PACKAGE_NAME } from './stage-npm-cli.mjs'

const { compileCacheDir } = createRequire(import.meta.url)('../packaging/npm/houston.cjs')

const rootPkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8'))

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

  it('installs `houston` as the launcher and ships only it, the bundle and the Apache NOTICE', () => {
    expect(manifest.bin).toEqual({ houston: 'houston.cjs' })
    expect(manifest.files).toEqual(['houston.cjs', 'houston-cli.cjs', 'NOTICE'])
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

describe('assertRunsFromLauncher', () => {
  it('accepts a bundle that exports runAsEntry', () => {
    expect(() => assertRunsFromLauncher('module.exports={main:()=>a,runAsEntry:()=>b}')).not.toThrow()
  })

  // An older bundle would load under the launcher and then do nothing.
  it('refuses a bundle without it', () => {
    expect(() => assertRunsFromLauncher('module.exports={main:()=>a}', 'old.cjs')).toThrow(/old\.cjs exports no runAsEntry/)
  })
})

describe('compileCacheDir', () => {
  // The same folders as the Homebrew and AUR wrappers (scripts/render-packaging.mjs).
  it('uses ~/Library/Caches on macOS', () => {
    expect(compileCacheDir({}, 'darwin', '/Users/u')).toBe(join('/Users/u', 'Library', 'Caches', 'houston', 'compile-cache'))
  })

  it('uses XDG_CACHE_HOME on Linux, falling back to ~/.cache when it is unset or empty', () => {
    expect(compileCacheDir({ XDG_CACHE_HOME: '/xdg' }, 'linux', '/home/u')).toBe(join('/xdg', 'houston', 'compile-cache'))
    expect(compileCacheDir({}, 'linux', '/home/u')).toBe(join('/home/u', '.cache', 'houston', 'compile-cache'))
    expect(compileCacheDir({ XDG_CACHE_HOME: '' }, 'linux', '/home/u')).toBe(join('/home/u', '.cache', 'houston', 'compile-cache'))
  })

  it('uses LOCALAPPDATA on Windows, falling back to the home folder', () => {
    expect(compileCacheDir({ LOCALAPPDATA: 'C:\\L' }, 'win32', 'C:\\U')).toBe(join('C:\\L', 'houston', 'compile-cache'))
    expect(compileCacheDir({}, 'win32', 'C:\\U')).toBe(join('C:\\U', 'AppData', 'Local', 'houston', 'compile-cache'))
  })
})

// Stages a stand-in bundle and runs the staged launcher as a real process. The stand-in's
// runAsEntry prints the compile-cache folder Node ended up with, so these cover the
// launcher's environment handling and its hand-off to the bundle together.
describe('staged npm package', () => {
  const script = resolve(__dirname, 'stage-npm-cli.mjs')
  let dir
  let home
  let out

  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'houston-npm-stage-')))
    home = join(dir, 'home')
    out = join(dir, 'pkg')
    const bundle = join(dir, 'bundle.cjs')
    writeFileSync(
      bundle,
      "#!/usr/bin/env node\nexports.runAsEntry = () => { process.stdout.write(String(require('node:module').getCompileCacheDir?.() ?? 'off')) }\n"
    )
    const staged = spawnSync(process.execPath, [script, '--cli', bundle, '--out', out], { encoding: 'utf8' })
    expect(staged.status, staged.stderr).toBe(0)
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const run = (env) => {
    const base = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, 'AppData', 'Local') }
    const r = spawnSync(process.execPath, [join(out, 'houston.cjs')], { encoding: 'utf8', env: { ...base, ...env } })
    expect(r.status, r.stderr).toBe(0)
    return r.stdout
  }

  it('ships the launcher next to the bundle, as the package bin', () => {
    const manifest = JSON.parse(readFileSync(join(out, 'package.json'), 'utf8'))
    expect(manifest.bin).toEqual({ houston: 'houston.cjs' })
    expect(readFileSync(join(out, 'houston.cjs'), 'utf8')).toBe(readFileSync(resolve(__dirname, '../packaging/npm/houston.cjs'), 'utf8'))
  })

  it("turns the cache on in the user's cache folder, then runs the bundle", () => {
    const got = run({})
    // Node may add a per-version folder inside the one it was given.
    expect(got.startsWith(compileCacheDir({ LOCALAPPDATA: join(home, 'AppData', 'Local') }, process.platform, home))).toBe(true)
  })

  it('leaves a NODE_COMPILE_CACHE the user set alone, even an empty one', () => {
    const mine = join(dir, 'mine')
    expect(run({ NODE_COMPILE_CACHE: mine }).startsWith(mine)).toBe(true)
    expect(run({ NODE_COMPILE_CACHE: '' })).toBe('off')
  })

  it('keeps the cache off under NODE_DISABLE_COMPILE_CACHE', () => {
    expect(run({ NODE_DISABLE_COMPILE_CACHE: '1' })).toBe('off')
  })

  it('refuses to stage a bundle the launcher cannot run', () => {
    const old = join(dir, 'old.cjs')
    writeFileSync(old, '#!/usr/bin/env node\nconsole.log(1)\n')
    const r = spawnSync(process.execPath, [script, '--cli', old, '--out', join(dir, 'old-pkg')], { encoding: 'utf8' })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/exports no runAsEntry/)
  })
})
