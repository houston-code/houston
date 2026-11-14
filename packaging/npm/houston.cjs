#!/usr/bin/env node
'use strict'

// The `houston` command of the npm package (@houston-code/cli). It turns on Node's
// on-disk compile cache, then starts the bundle next to it (houston-cli.cjs), so a start
// reuses the compiled bundle instead of recompiling all of it. The cache has to be on
// before the bundle is required: Node compiles a script before any of its code runs, so
// the bundle can't turn it on for itself.
//
// The cache lives in the same per-user directory the Homebrew and AUR wrappers use. A
// NODE_COMPILE_CACHE the caller set (even to empty) wins, and is left as it is. Turning
// the cache on here does not set NODE_COMPILE_CACHE, so the programs Houston starts
// (shell commands, MCP servers) don't inherit it.
//
// Plain CommonJS on Node's own modules only: it runs straight from the package.

const path = require('node:path')

/**
 * The compile-cache directory for this user, or undefined for Node's default (the
 * system temp dir), e.g. with no home directory. A relative XDG_CACHE_HOME or
 * LOCALAPPDATA is ignored, as the XDG spec asks, rather than caching under the cwd.
 */
function compileCacheDir(platform, env, home) {
  const { isAbsolute, join } = platform === 'win32' ? path.win32 : path.posix
  const absolute = (dir) => (dir && isAbsolute(dir) ? dir : undefined)
  const userHome = absolute(home)
  if (platform === 'win32') {
    const local = absolute(env.LOCALAPPDATA) ?? (userHome && join(userHome, 'AppData', 'Local'))
    return local && join(local, 'houston', 'compile-cache')
  }
  if (!userHome) return undefined
  if (platform === 'darwin') return join(userHome, 'Library', 'Caches', 'houston', 'compile-cache')
  return join(absolute(env.XDG_CACHE_HOME) ?? join(userHome, '.cache'), 'houston', 'compile-cache')
}

/** Turn the compile cache on unless the caller decided. Best effort: never throws. */
function enableCompileCache() {
  if (process.env.NODE_COMPILE_CACHE !== undefined) return
  try {
    const nodeModule = require('node:module')
    if (typeof nodeModule.enableCompileCache !== 'function') return
    let home
    try {
      home = require('node:os').homedir()
    } catch {
      // No home directory: Node's default location.
    }
    nodeModule.enableCompileCache(compileCacheDir(process.platform, process.env, home))
  } catch {
    // A cache that can't be turned on only costs start-up time.
  }
}

if (require.main === module) {
  enableCompileCache()
  require('./houston-cli.cjs').startCli()
}

module.exports = { compileCacheDir }
