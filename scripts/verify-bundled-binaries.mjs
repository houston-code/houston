#!/usr/bin/env node
// Guard against shipping a packaged app that's silently missing a vendored CLI
// binary. The `afterPack` hook (scripts/copy-bundled-binaries.mjs) copies the
// per-(os,arch) `rg`/`ast-grep` into Resources/bin so search/structural-search work
// out of the box. But electron-builder treats a missing copy source as nothing more
// than a warning, and a stale/corrupt npm cache can make `npm ci` skip an optional
// platform sub-package without erroring — yielding an app with no search binaries.
//
// This script runs immediately before `electron-builder` in the `dist*` npm scripts.
// It consults the SAME BINARY_MAP the afterPack hook uses (single source of truth) for
// the platform+arch(es) this build targets, asserts each source exists as a non-empty
// file, attempts a targeted version-pinned reinstall if not, and FAILS the build with
// actionable remediation if any is still missing.

import { readFileSync, existsSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BINARY_MAP } from './copy-bundled-binaries.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

/** Map Node's process.platform to electron-builder's electronPlatformName. */
const PLATFORM = { darwin: 'darwin', linux: 'linux', win32: 'win32' }

/**
 * The `(platform, arch)` keys this build targets. Defaults to the host platform + host
 * arch — the only sub-package npm is guaranteed to have installed on this runner.
 * Cross-arch builds (a second runner) pass explicit `--arch` flags.
 */
export function targetKeys({ platform = process.platform, archs = [process.arch] } = {}) {
  const p = PLATFORM[platform]
  if (!p) throw new Error(`verify-bundled-binaries: unsupported platform "${platform}"`)
  return archs.map((a) => `${p}-${a}`)
}

/** The `{ key, pkg, from }` vendored-binary sources to verify for a set of target keys. */
export function expectedSources(keys) {
  const out = []
  for (const key of keys) {
    const entry = BINARY_MAP[key]
    if (!entry) throw new Error(`verify-bundled-binaries: no binary map for target "${key}"`)
    for (const b of Object.values(entry)) {
      out.push({ key, pkg: b.pkg, from: `node_modules/${b.pkg}/${b.file}` })
    }
  }
  return out
}

/**
 * A source is "present" when it exists and, for files, is non-empty — a 0-byte
 * binary is as broken as a missing one. `fs` is injectable so this stays unit-testable.
 */
export function sourceIsPresent(absFrom, { exists = existsSync, stat = statSync } = {}) {
  if (!exists(absFrom)) return false
  try {
    const s = stat(absFrom)
    return s.isDirectory() || s.size > 0
  } catch {
    return false
  }
}

/** Look up a package's exact version from package-lock.json, or null if absent. */
function lockedVersion(pkg) {
  try {
    const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'))
    return lock.packages?.[`node_modules/${pkg}`]?.version ?? null
  } catch {
    return null
  }
}

/**
 * Best-effort, version-pinned reinstall of a single package. Pin the version from the
 * lockfile so the platform binary matches its parent CLI exactly; --force installs it
 * even when npm's optional-dependency bookkeeping would skip it; --no-save keeps
 * package.json / package-lock untouched.
 */
function tryRepair(pkg) {
  const version = lockedVersion(pkg)
  if (!version) {
    console.warn(`  ✗ cannot auto-repair ${pkg}: no version found in package-lock.json`)
    return
  }
  const spec = `${pkg}@${version}`
  console.warn(`  ↻ reinstalling ${spec} …`)
  try {
    execFileSync('npm', ['install', '--no-save', '--no-audit', '--no-fund', '--force', spec], {
      cwd: ROOT,
      stdio: 'inherit'
    })
  } catch (err) {
    console.warn(`  ✗ reinstall of ${spec} failed: ${err.message}`)
  }
}

/** Parse repeatable `--arch <a>` and optional `--platform <p>` flags. */
export function parseArgs(argv) {
  const archs = []
  let platform
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--arch' && argv[i + 1]) archs.push(argv[++i])
    else if (argv[i] === '--platform' && argv[i + 1]) platform = argv[++i]
  }
  return { platform, archs: archs.length ? archs : undefined }
}

async function main() {
  const { platform, archs } = parseArgs(process.argv.slice(2))
  const keys = targetKeys({ platform: platform ?? process.platform, archs: archs ?? [process.arch] })
  const sources = expectedSources(keys)

  const missing = sources.filter((s) => !sourceIsPresent(join(ROOT, s.from)))

  // Self-heal: a missing source is almost always an un-installed optional platform
  // package. Reinstall each owning package once, then re-check.
  if (missing.length > 0) {
    console.warn(`verify-bundled-binaries: ${missing.length} vendored source(s) missing — attempting repair…`)
    const repaired = new Set()
    for (const s of missing) {
      if (!repaired.has(s.pkg)) {
        repaired.add(s.pkg)
        tryRepair(s.pkg)
      }
    }
  }

  const stillMissing = sources.filter((s) => !sourceIsPresent(join(ROOT, s.from)))
  if (stillMissing.length > 0) {
    console.error('\n✗ Packaging aborted — these vendored binary sources are missing:\n')
    for (const s of stillMissing) {
      console.error(`  • ${s.from}  (target ${s.key}, provided by ${s.pkg})`)
    }
    console.error(
      '\nThe usual cause is npm skipping an optional platform package (a known npm\n' +
        'optional-dependency flake, often a stale ~/.npm cache). A clean reinstall fixes it:\n\n' +
        '  npm cache clean --force\n' +
        '  rm -rf node_modules\n' +
        '  npm ci\n\n' +
        'Without this gate, the build would only WARN and ship an app missing these binaries.\n'
    )
    process.exit(1)
  }

  console.log(`✓ verify-bundled-binaries: all ${sources.length} source(s) present for ${keys.join(', ')}:`)
  for (const s of sources) console.log(`    ${s.from}`)
}

// Run only when invoked directly, not when imported by the unit test.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
