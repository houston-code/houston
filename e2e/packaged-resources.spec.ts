import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

const ROOT = join(__dirname, '..')

/**
 * The vendored CLI binaries bundled into the app via the afterPack hook
 * (scripts/copy-bundled-binaries.mjs, see electron-builder.yml). The packaged app
 * must carry each one under Contents/Resources/bin so search (rg) and structural
 * search (ast-grep) work without anything on the user's PATH. This guards against the
 * silent-warning failure mode where electron-builder ships an app missing a
 * binary because its source wasn't installed (see scripts/verify-bundled-binaries.mjs).
 */
const BUNDLED_BINARIES = ['rg', 'ast-grep']

/** Locate the packaged app's Contents/Resources dir, or null if no packaged app exists. */
function packagedResourcesDir(): string | null {
  for (const dir of ['mac-arm64', 'mac', 'mac-universal']) {
    const app = join(ROOT, 'release', dir, 'Houston.app')
    if (existsSync(app)) return join(app, 'Contents', 'Resources')
  }
  return null
}

const resourcesDir = packagedResourcesDir()
const binDir = resourcesDir ? join(resourcesDir, 'bin') : null

test('packaged app bundles rg and ast-grep as non-empty executables', () => {
  // Only `npm run dist` produces a Resources/bin. For fast local runs against the
  // unpackaged out/ bundle there's nothing to assert, so skip. In CI (build-mac)
  // `npm run dist` always runs before the e2e suite, so this never skips there —
  // a missing packaged app then fails the assertion below rather than skipping.
  test.skip(!binDir && !process.env.CI, 'no packaged app in release/ (unpackaged local run)')

  expect(binDir, 'packaged Houston.app not found in release/ — did `npm run dist` run first?').toBeTruthy()

  for (const name of BUNDLED_BINARIES) {
    const p = join(binDir as string, name)
    expect(existsSync(p), `${name} is missing from the packaged Resources/bin`).toBe(true)
    const s = statSync(p)
    expect(s.size, `${name} is present but empty`).toBeGreaterThan(0)
    // Owner-executable bit — a non-executable binary won't spawn at runtime.
    expect(s.mode & 0o100, `${name} is not marked executable`).toBeGreaterThan(0)
  }
})

/**
 * License and attribution files shipped via electron-builder `extraResources`, so they
 * travel INSIDE the code-signed, notarized bundle (see electron-builder.yml). LICENSE and
 * NOTICE are Houston's own Apache-2.0 obligations (§4(a) and §4(d) require both to
 * accompany every distribution, binaries included); THIRD-PARTY-NOTICES.md discharges the
 * same duty for the bundled dependencies.
 */
const BUNDLED_LICENSE_FILES = ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md']

test('packaged app bundles the license and attribution files under Resources', () => {
  // Same skip logic as the binaries test above.
  test.skip(!resourcesDir && !process.env.CI, 'no packaged app in release/ (unpackaged local run)')

  expect(resourcesDir, 'packaged Houston.app not found in release/ — did `npm run dist` run first?').toBeTruthy()

  for (const name of BUNDLED_LICENSE_FILES) {
    const p = join(resourcesDir as string, name)
    expect(existsSync(p), `${name} is missing from the packaged Resources`).toBe(true)
    expect(statSync(p).size, `${name} is present but empty`).toBeGreaterThan(0)
  }
})
