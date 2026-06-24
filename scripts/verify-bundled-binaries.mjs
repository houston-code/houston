#!/usr/bin/env node
// Guard against shipping a packaged app that's silently missing a vendored CLI
// binary. We copy `rg` (ripgrep) and `ast-grep` into the app's Resources/bin via
// electron-builder `extraResources` (see electron-builder.yml) so search and
// structural search work out of the box, independent of the user's PATH.
//
// The trap: electron-builder treats a missing `extraResources` `from:` source as
// a WARNING — it logs `file source doesn't exist` and copies nothing, yet the
// build still succeeds. The result is a Houston.app with no Resources/bin/ast-grep
// (structural search silently unavailable) or no rg (search degraded).
//
// A source goes missing when npm skips the optional platform sub-package that
// ships the prebuilt binary (e.g. `@ast-grep/cli-darwin-arm64`). The lockfile
// pins it correctly with matching os/cpu, so on a clean install it's present —
// but a stale/corrupt `~/.npm` cache (a long-standing npm optional-dependency
// flake) can make `npm ci` skip it without erroring.
//
// This script runs immediately before `electron-builder` in the `dist` /
// `dist:unpacked` npm scripts. It reads every extraResources entry from
// electron-builder.yml and asserts each `from:` source exists as a non-empty
// file. If one is missing it attempts a targeted, version-pinned reinstall of the
// owning package and, only if it's still missing, FAILS the build with actionable
// remediation — so this class of bug can never silently regress again.

import { readFileSync, existsSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

/**
 * Normalize the `extraResources` list from a parsed electron-builder config into
 * `{ from, to }` objects. electron-builder accepts either a bare string (used as
 * both from and to) or a `{ from, to }` object; we only care about `from`.
 */
export function extractExtraResources(config) {
  const entries = Array.isArray(config?.extraResources) ? config.extraResources : []
  return entries
    .map((e) => (typeof e === 'string' ? { from: e, to: e } : e))
    .filter((e) => e && typeof e.from === 'string')
}

/**
 * A source is "present" when it exists and, for files, is non-empty — a 0-byte
 * binary is as broken as a missing one. Directories are accepted as-is. `fs` is
 * injectable so this stays unit-testable.
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

/**
 * Derive the owning npm package name from a `node_modules/...` path so we can
 * reinstall just that package. Handles scoped packages (`@scope/name`) and nested
 * `node_modules` (takes the last segment). Returns null for non-node_modules paths.
 */
export function packageFromResourcePath(from) {
  const marker = 'node_modules/'
  const idx = from.lastIndexOf(marker)
  if (idx === -1) return null
  const rest = from.slice(idx + marker.length).split('/').filter(Boolean)
  if (rest.length === 0) return null
  return rest[0].startsWith('@') && rest.length > 1 ? `${rest[0]}/${rest[1]}` : rest[0]
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
 * Best-effort, version-pinned reinstall of a single package. We pin the version
 * from the lockfile so the platform binary matches its parent CLI exactly, and
 * use --force so npm installs it even when its optional-dependency bookkeeping
 * would otherwise skip it. --no-save keeps package.json / package-lock untouched.
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

async function main() {
  const ymlPath = join(ROOT, 'electron-builder.yml')

  let yaml
  try {
    yaml = (await import('js-yaml')).default
  } catch {
    console.error('verify-bundled-binaries: js-yaml not found (it ships with electron-builder). Run `npm ci`.')
    process.exit(1)
  }

  const resources = extractExtraResources(yaml.load(readFileSync(ymlPath, 'utf8')))
  if (resources.length === 0) {
    console.error('verify-bundled-binaries: no extraResources found in electron-builder.yml — nothing to verify.')
    process.exit(1)
  }

  const missing = resources.filter((r) => !sourceIsPresent(join(ROOT, r.from)))

  // Self-heal: a missing source is almost always an un-installed optional
  // platform package. Reinstall each owning package once, then re-check.
  if (missing.length > 0) {
    console.warn(`verify-bundled-binaries: ${missing.length} vendored source(s) missing — attempting repair…`)
    const repaired = new Set()
    for (const r of missing) {
      const pkg = packageFromResourcePath(r.from)
      if (pkg && !repaired.has(pkg)) {
        repaired.add(pkg)
        tryRepair(pkg)
      }
    }
  }

  const stillMissing = resources.filter((r) => !sourceIsPresent(join(ROOT, r.from)))
  if (stillMissing.length > 0) {
    console.error('\n✗ Packaging aborted — these extraResources sources are missing:\n')
    for (const r of stillMissing) {
      const pkg = packageFromResourcePath(r.from)
      console.error(`  • ${r.from}  →  Resources/${r.to}${pkg ? `   (provided by ${pkg})` : ''}`)
    }
    console.error(
      '\nThe usual cause is npm skipping an optional platform package (a known npm\n' +
        'optional-dependency flake, often a stale ~/.npm cache). A clean reinstall fixes it:\n\n' +
        '  npm cache clean --force\n' +
        '  rm -rf node_modules\n' +
        '  npm ci\n\n' +
        'Without this gate, electron-builder would only WARN and ship an app missing these binaries.\n'
    )
    process.exit(1)
  }

  console.log(`✓ verify-bundled-binaries: all ${resources.length} extraResources source(s) present:`)
  for (const r of resources) console.log(`    ${r.from} → Resources/${r.to}`)
}

// Run only when invoked directly (`node scripts/verify-bundled-binaries.mjs`),
// not when imported by the unit test.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
