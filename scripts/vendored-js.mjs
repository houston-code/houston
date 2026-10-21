// JavaScript bundles vendored into the packaged app from devDependencies.
//
// Mermaid (inline diagrams) ships as a single prebuilt file, dist/mermaid.min.js,
// copied into out/main/vendor at build time (see electron.vite.config.ts). Installing
// it as a production dependency would ship its whole ~135 MB dependency tree in the
// asar for one 2.5 MB file, so it is a devDependency instead. That file still bundles
// mermaid AND its dependencies, so for attribution (generate-notices.mjs) and license
// policy (license-gate.mjs) the package and its full dependency subtree count as
// shipped, exactly like the production closure.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Packages whose prebuilt bundle is copied into the app; their subtrees ship. */
export const VENDORED_JS_PACKAGES = ['mermaid']

/**
 * The installed directory Node would resolve `name` to from `fromDir`: the nearest
 * `node_modules/<name>` walking up from `fromDir`, but never above `root`.
 */
export function resolvePackageDir(name, fromDir, root, exists = existsSync) {
  let dir = fromDir
  for (;;) {
    const candidate = join(dir, 'node_modules', name)
    if (exists(join(candidate, 'package.json'))) return candidate
    if (dir === root) return null
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Absolute dirs of each vendored package and everything it depends on
 * (dependencies and installed optionalDependencies), resolved the way Node resolves
 * them. Missing packages are skipped: an optional dependency for another platform is
 * simply not installed.
 */
export function vendoredJsDirs(root, { packages = VENDORED_JS_PACKAGES, exists = existsSync, read = readFileSync } = {}) {
  const seen = new Set()
  const queue = []
  for (const name of packages) {
    const dir = resolvePackageDir(name, root, root, exists)
    if (dir) queue.push(dir)
  }
  while (queue.length) {
    const dir = queue.shift()
    if (seen.has(dir)) continue
    seen.add(dir)
    let pkg
    try {
      pkg = JSON.parse(read(join(dir, 'package.json'), 'utf8'))
    } catch {
      continue
    }
    const deps = { ...(pkg.optionalDependencies ?? {}), ...(pkg.dependencies ?? {}) }
    for (const name of Object.keys(deps)) {
      const child = resolvePackageDir(name, dir, root, exists)
      if (child && !seen.has(child)) queue.push(child)
    }
  }
  return seen
}
