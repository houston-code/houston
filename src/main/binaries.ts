import { join } from 'node:path'
import { existsSync } from 'node:fs'

/**
 * Resolve CLI binaries (ripgrep, ast-grep) that ship with the packaged app.
 *
 * electron-builder copies vendored binaries into `Resources/bin` via
 * `extraResources` (see electron-builder.yml), so a packaged build always has a
 * fast search/structural-search binary regardless of what's on the user's PATH.
 * In development (and under tests) `process.resourcesPath` doesn't point at our
 * bundle, so these return null and callers fall back to a PATH lookup and then a
 * pure-JS implementation.
 */

export interface ResolveBundledOptions {
  /** App resources dir; defaults to Electron's `process.resourcesPath`. */
  resourcesPath?: string
  exists?: (p: string) => boolean
}

/** Resolve a bundled binary by name, or null when it isn't present. */
export function resolveBundledBinary(name: string, opts: ResolveBundledOptions = {}): string | null {
  const exists = opts.exists ?? existsSync
  // In a non-Electron context (vitest) `process.resourcesPath` is undefined.
  const resources = opts.resourcesPath ?? (process.resourcesPath as string | undefined)
  if (!resources) return null
  const p = join(resources, 'bin', name)
  return exists(p) ? p : null
}

/** Path to the bundled ripgrep binary, or null to fall back to PATH/JS search. */
export function bundledRipgrep(opts?: ResolveBundledOptions): string | null {
  return resolveBundledBinary('rg', opts)
}

/** Path to the bundled ast-grep binary, or null to fall back to PATH. */
export function bundledAstGrep(opts?: ResolveBundledOptions): string | null {
  return resolveBundledBinary('ast-grep', opts)
}
