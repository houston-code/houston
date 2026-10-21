import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  bundledPackagesGuard,
  packageDirOf,
  packageNameOf,
  productionPackageDirs,
  uncoveredMessage,
  uncoveredPackageDirs
} from './bundled-packages.mjs'
import { BUNDLED_DEV_PACKAGES, VENDORED_JS_PACKAGES } from './vendored-js.mjs'

const ROOT = '/repo'
const identity = (p) => p

describe('packageDirOf', () => {
  it('maps a module id to its package dir, scoped names included', () => {
    expect(packageDirOf('/repo/node_modules/react/cjs/react.production.js')).toBe('/repo/node_modules/react')
    expect(packageDirOf('/repo/node_modules/@xterm/xterm/lib/xterm.mjs')).toBe('/repo/node_modules/@xterm/xterm')
  })

  it('takes the innermost node_modules, so a nested copy maps to itself', () => {
    expect(packageDirOf('/repo/node_modules/khroma/node_modules/d3-array/src/index.js')).toBe(
      '/repo/node_modules/khroma/node_modules/d3-array'
    )
  })

  it('strips virtual prefixes and queries, and normalizes Windows separators', () => {
    expect(packageDirOf('\0/repo/node_modules/react/index.js?commonjs-module')).toBe('/repo/node_modules/react')
    expect(packageDirOf('C:\\repo\\node_modules\\@scope\\pkg\\index.js')).toBe('C:/repo/node_modules/@scope/pkg')
  })

  it('is null for project source and bundler helpers', () => {
    expect(packageDirOf('/repo/src/renderer/src/App.tsx')).toBeNull()
    expect(packageDirOf('\0vite/preload-helper.js')).toBeNull()
    expect(packageDirOf('\0commonjsHelpers.js')).toBeNull()
    expect(packageDirOf('/repo/node_modules/@scope')).toBeNull()
  })

  it('names the package a dir holds', () => {
    expect(packageNameOf('/repo/node_modules/@xterm/xterm')).toBe('@xterm/xterm')
    expect(packageNameOf('/repo/node_modules/a/node_modules/b')).toBe('b')
  })
})

describe('uncoveredPackageDirs', () => {
  const covered = new Set(['/repo/node_modules/highlight.js', '/repo/node_modules/react'])

  it('reports each uncovered package once, sorted, and ignores covered ones and source', () => {
    const ids = [
      '/repo/src/main.tsx',
      '/repo/node_modules/react/index.js',
      '/repo/node_modules/scheduler/index.js',
      '/repo/node_modules/react-dom/client.js',
      '/repo/node_modules/react-dom/cjs/react-dom-client.production.js',
      '/repo/node_modules/highlight.js/lib/core.js'
    ]
    expect(uncoveredPackageDirs(ids, covered, identity)).toEqual(['/repo/node_modules/react-dom', '/repo/node_modules/scheduler'])
  })

  it('treats a nested copy as its own package, even when the hoisted one is covered', () => {
    const ids = ['/repo/node_modules/x/node_modules/react/index.js']
    expect(uncoveredPackageDirs(ids, covered, identity)).toEqual(['/repo/node_modules/x/node_modules/react'])
  })

  it('compares through the canonicalizer, so separator and symlink spellings still match', () => {
    const canonical = (p) => p.replace(/\\/g, '/').replace('/linked/', '/repo/')
    expect(uncoveredPackageDirs(['/linked/node_modules/react/index.js'], covered, canonical)).toEqual([])
    expect(uncoveredPackageDirs(['/repo/node_modules/react/index.js'], ['\\repo\\node_modules\\react'], canonical)).toEqual([])
  })
})

describe('uncoveredMessage', () => {
  it('is null when everything is covered', () => {
    expect(uncoveredMessage('renderer', [], ROOT)).toBeNull()
  })

  it('names the bundle, each package with its repo-relative dir, and the fix', () => {
    const msg = uncoveredMessage('renderer', ['/repo/node_modules/react-dom', '/repo/node_modules/@a/b'], ROOT)
    expect(msg).toContain('The renderer bundle inlines')
    expect(msg).toContain('  react-dom (node_modules/react-dom)')
    expect(msg).toContain('  @a/b (node_modules/@a/b)')
    expect(msg).toContain('BUNDLED_DEV_PACKAGES')
    expect(msg).not.toContain('—')
  })
})

describe('productionPackageDirs', () => {
  const listing = '/repo\n/repo/node_modules/a\n\n/repo/node_modules/a/node_modules/b\n/elsewhere\n'

  it('keeps installed package dirs from npm ls and drops the project root', () => {
    expect([...productionPackageDirs(ROOT, () => listing)]).toEqual(['/repo/node_modules/a', '/repo/node_modules/a/node_modules/b'])
  })

  it('starts npm through a shell only on Windows, where it is npm.cmd', () => {
    const shells = []
    const exec = (_cmd, _args, opts) => (shells.push(opts.shell), listing)
    productionPackageDirs(ROOT, exec, 'win32')
    productionPackageDirs(ROOT, exec, 'linux')
    expect(shells).toEqual([true, false])
  })

  it('reads Windows npm ls output, CRLF line endings included', () => {
    const out = 'C:\\repo\r\nC:\\repo\\node_modules\\a\r\n'
    expect([...productionPackageDirs('C:\\repo', () => out, 'win32')]).toEqual(['C:\\repo\\node_modules\\a'])
  })

  it('uses what npm ls printed when it exits non-zero on a tree warning, and rethrows when it printed nothing', () => {
    const warn = () => {
      throw Object.assign(new Error('ELSPROBLEMS'), { stdout: listing })
    }
    expect(productionPackageDirs(ROOT, warn).size).toBe(2)
    const fail = () => {
      throw Object.assign(new Error('ENOENT'), { stdout: '' })
    }
    expect(() => productionPackageDirs(ROOT, fail)).toThrow('ENOENT')
  })
})

describe('bundledPackagesGuard', () => {
  it('only runs on builds', () => {
    expect(bundledPackagesGuard('renderer').apply).toBe('build')
  })

  it('passes a bundle of covered modules and fails one that inlines an uncovered package', () => {
    // Runs against this repo's real install: react is covered via
    // BUNDLED_DEV_PACKAGES, and a made-up nested package dir is not.
    const root = process.cwd()
    const guard = bundledPackagesGuard('renderer', root)
    const errors = []
    const ctx = { error: (m) => errors.push(m) }
    const chunk = (ids) => ({ c: { type: 'chunk', modules: Object.fromEntries(ids.map((id) => [id, {}])) }, a: { type: 'asset' } })
    guard.generateBundle.call(ctx, {}, chunk([`${root}/node_modules/react/index.js`, `${root}/src/renderer/src/main.tsx`]))
    expect(errors).toEqual([])
    guard.generateBundle.call(ctx, {}, chunk([`${root}/node_modules/react/node_modules/not-installed/index.js`]))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('not-installed')
  }, 60_000)
})

describe('wiring', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

  it('lists only devDependencies (a production dependency is already covered by the closure)', () => {
    for (const name of [...VENDORED_JS_PACKAGES, ...BUNDLED_DEV_PACKAGES]) {
      expect(pkg.devDependencies?.[name], name).toBeTruthy()
      expect(pkg.dependencies?.[name], name).toBeUndefined()
    }
  })

  it('guards every electron-vite target and the CLI bundle', () => {
    const config = readFileSync('electron.vite.config.ts', 'utf8')
    for (const target of ['main', 'preload', 'renderer']) {
      expect(config).toContain(`bundledPackagesGuard('${target}')`)
    }
    expect(readFileSync('scripts/build-cli.mjs', 'utf8')).toMatch(/uncoveredPackageDirs\(\s*Object\.keys\(result\.metafile\.inputs\)/)
  })
})
