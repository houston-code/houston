import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { findPackagedApp } from './launch'

/**
 * The vendored CLI binaries bundled into the app via the afterPack hook
 * (scripts/copy-bundled-binaries.mjs, see electron-builder.yml). The packaged app
 * must carry each one under its resources bin/ dir so search (rg) and structural
 * search (ast-grep) work without anything on the user's PATH. This guards against the
 * silent-warning failure mode where electron-builder ships an app missing a
 * binary because its source wasn't installed (see scripts/verify-bundled-binaries.mjs).
 */
const BUNDLED_BINARIES: Array<{ name: string; version: RegExp }> = [
  { name: 'rg', version: /^ripgrep \d+\.\d+\.\d+/ },
  { name: 'ast-grep', version: /^ast-grep \d+\.\d+\.\d+/ }
]

const resourcesDir = findPackagedApp()?.resources ?? null
const binDir = resourcesDir ? join(resourcesDir, 'bin') : null
const exe = process.platform === 'win32' ? '.exe' : ''

test('packaged app bundles rg and ast-grep as working executables for this platform', () => {
  // Only `npm run dist` produces a Resources/bin. For fast local runs against the
  // unpackaged out/ bundle there's nothing to assert, so skip. In CI (the package job)
  // `npm run dist` always runs before the e2e suite, so this never skips there —
  // a missing packaged app then fails the assertion below rather than skipping.
  test.skip(!binDir && !process.env.CI, 'no packaged app in release/ (unpackaged local run)')

  expect(binDir, 'no packaged app in release/ for this platform. Did `npm run dist*` run first?').toBeTruthy()

  for (const { name, version } of BUNDLED_BINARIES) {
    const p = join(binDir as string, name + exe)
    expect(existsSync(p), `${name} is missing from the packaged Resources/bin`).toBe(true)
    const s = statSync(p)
    expect(s.size, `${name} is present but empty`).toBeGreaterThan(0)
    // Owner-executable bit: a non-executable binary won't spawn at runtime. Windows has
    // no such bit; there the spawn below is the whole check.
    if (process.platform !== 'win32') {
      expect(s.mode & 0o100, `${name} is not marked executable`).toBeGreaterThan(0)
    }
    // Actually run it. A file that exists but was vendored for the wrong arch or OS, or
    // that the OS refuses to execute (quarantine, a broken signature under the hardened
    // runtime on the signed release leg), passes every check above and fails only here.
    const out = execFileSync(p, ['--version'], { encoding: 'utf8', timeout: 15_000 })
    expect(out.trim(), `${name} --version printed something unexpected`).toMatch(version)
  }
})

/**
 * License and attribution files shipped via electron-builder `extraResources`, so they
 * travel INSIDE the code-signed, notarized bundle (see electron-builder.yml). LICENSE and
 * NOTICE are Houston's own Apache-2.0 obligations (§4(a) and §4(d) require both to
 * accompany every distribution, binaries included); THIRD-PARTY-NOTICES.md discharges the
 * same duty for the bundled dependencies. TRADEMARK.md ships alongside them because NOTICE
 * carves the logo artwork out of the Apache grant and points at TRADEMARK.md for the terms
 * that replace it, so the pointer has to resolve inside the bundle too.
 */
const BUNDLED_LICENSE_FILES = ['LICENSE', 'NOTICE', 'TRADEMARK.md', 'THIRD-PARTY-NOTICES.md']

test('packaged app bundles the license and attribution files under Resources', () => {
  // Same skip logic as the binaries test above.
  test.skip(!resourcesDir && !process.env.CI, 'no packaged app in release/ (unpackaged local run)')

  expect(resourcesDir, 'no packaged app in release/ for this platform. Did `npm run dist*` run first?').toBeTruthy()

  for (const name of BUNDLED_LICENSE_FILES) {
    const p = join(resourcesDir as string, name)
    expect(existsSync(p), `${name} is missing from the packaged Resources`).toBe(true)
    expect(statSync(p).size, `${name} is present but empty`).toBeGreaterThan(0)
  }
})
