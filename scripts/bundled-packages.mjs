// Build-time attribution guard: every npm package a bundler inlines into a shipped
// artifact must be one that THIRD-PARTY-NOTICES.md and the license gate already cover.
//
// Those two read the production closure (`npm ls --omit=dev`) plus the vendored-js.mjs
// lists, without building. A bundler, though, inlines whatever the source imports,
// devDependencies included (the renderer bundles react and react-dom), so the lists can
// fall behind the build. This guard closes that gap from the build's side: the
// electron-vite builds (main, preload, renderer) and the standalone CLI bundle hand it
// the module ids they actually emitted, and the build fails, naming the package, when
// one resolves to an installed package dir outside that coverage.

import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { vendoredJsDirs } from './vendored-js.mjs'

/**
 * The installed package dir a bundled module id lives in, or null for project source
 * and bundler-generated virtual modules. Ids may carry a `\0` virtual prefix or a
 * `?query` suffix; the innermost `node_modules/<name>` wins, so a nested copy maps to
 * itself rather than to the package it is nested under.
 */
export function packageDirOf(id) {
  const path = String(id).replace(/^\0/, '').replace(/\?.*$/, '').replace(/\\/g, '/')
  const at = path.lastIndexOf('/node_modules/')
  if (at < 0) return null
  const start = at + '/node_modules/'.length
  const parts = path.slice(start).split('/')
  const nameParts = parts[0].startsWith('@') ? 2 : 1
  if (parts.length < nameParts || !parts[nameParts - 1]) return null
  return path.slice(0, start) + parts.slice(0, nameParts).join('/')
}

/** The package name a dir from packageDirOf names. */
export function packageNameOf(dir) {
  return dir.slice(dir.lastIndexOf('/node_modules/') + '/node_modules/'.length)
}

function canonicalDefault(p) {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

/**
 * Package dirs (from packageDirOf, forward slashes) of the bundled ids that are not in
 * `covered`, sorted and deduped. Both sides go through `canonical` so a symlinked or
 * differently spelled path (Windows separators, a realpath'd module id) still matches.
 */
export function uncoveredPackageDirs(ids, covered, canonical = canonicalDefault) {
  const coveredCanon = new Set([...covered].map(canonical))
  const out = new Set()
  for (const id of ids) {
    const dir = packageDirOf(id)
    if (dir && !coveredCanon.has(canonical(dir))) out.add(dir)
  }
  return [...out].sort()
}

/** Installed dirs of the production closure, as the notices generator reads them. */
export function productionPackageDirs(root, exec = execFileSync) {
  let out
  try {
    out = exec('npm', ['ls', '--omit=dev', '--all', '--parseable'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch (err) {
    // npm ls exits non-zero on tree warnings (extraneous, missing peers) but still prints.
    out = err && typeof err.stdout === 'string' ? err.stdout : ''
    if (!out.trim()) throw err
  }
  const dirs = new Set()
  for (const line of out.split('\n')) {
    const d = line.trim()
    if (d && d !== root && d.includes('node_modules')) dirs.add(d)
  }
  return dirs
}

/** Every installed package dir the notices and the license gate cover. */
export function coveredPackageDirs(root) {
  return new Set([...productionPackageDirs(root), ...vendoredJsDirs(root)])
}

/**
 * The failure message for uncovered packages, or null when there are none. `target`
 * names the bundle (e.g. "renderer") so the error points at the build that pulled it in.
 */
export function uncoveredMessage(target, dirs, root) {
  if (!dirs.length) return null
  const list = dirs.map((d) => `  ${packageNameOf(d)} (${relative(root, d).replace(/\\/g, '/')})`).join('\n')
  return (
    `The ${target} bundle inlines npm packages that THIRD-PARTY-NOTICES.md and the license gate do not cover:\n${list}\n` +
    'They are not in the production dependency closure. Add each top-level one to BUNDLED_DEV_PACKAGES in ' +
    'scripts/vendored-js.mjs (or make it a production dependency), then run `npm run notices` and `npm run license-gate`.'
  )
}

let cachedCovered = null

/**
 * Vite/rollup plugin form of the guard, for electron.vite.config.ts. The covered set is
 * computed once per process (one `npm ls`) and shared by the main, preload and renderer
 * builds.
 */
export function bundledPackagesGuard(target, root = process.cwd()) {
  return {
    name: 'houston-bundled-packages-guard',
    apply: 'build',
    generateBundle(_options, bundle) {
      const ids = []
      for (const chunk of Object.values(bundle)) {
        if (chunk.type === 'chunk') ids.push(...Object.keys(chunk.modules))
      }
      cachedCovered ??= coveredPackageDirs(root)
      const message = uncoveredMessage(target, uncoveredPackageDirs(ids, cachedCovered), root)
      if (message) this.error(message)
    }
  }
}
