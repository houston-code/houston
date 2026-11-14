#!/usr/bin/env node
'use strict'

// The `houston` command of the npm package @houston-code/cli.
//
// It points Node's on-disk compile cache at the user's cache folder, then runs the bundle
// (houston-cli.cjs, the same bytes as the GitHub Release asset). The cache spares
// recompiling the multi-megabyte bundle on every start. Node only caches code it compiles
// after the cache is on, so this has to be a separate file: the bundle can't turn the
// cache on for itself.
//
// The Homebrew and AUR wrappers (scripts/render-packaging.mjs) do the same with the
// NODE_COMPILE_CACHE variable and use the same folders. A NODE_COMPILE_CACHE the user set,
// even to empty, wins, and NODE_DISABLE_COMPILE_CACHE still turns the cache off.

const { join } = require('node:path')

/** The cache folder for this platform, matching the Homebrew and AUR wrappers. */
function compileCacheDir(env, platform, home) {
  if (platform === 'darwin') return join(home, 'Library', 'Caches', 'houston', 'compile-cache')
  if (platform === 'win32') {
    return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'houston', 'compile-cache')
  }
  return join(env.XDG_CACHE_HOME || join(home, '.cache'), 'houston', 'compile-cache')
}

/**
 * Turn the compile cache on unless the user configured it. Never throws: without a cache
 * the CLI only starts a little slower, so any problem here is ignored.
 */
function enableCache(env = process.env, platform = process.platform) {
  if (env.NODE_COMPILE_CACHE !== undefined) return
  try {
    const { enableCompileCache } = require('node:module')
    // Added in Node 22.1; the package supports any Node 22.
    if (typeof enableCompileCache !== 'function') return
    enableCompileCache(compileCacheDir(env, platform, require('node:os').homedir()))
  } catch {
    // No cache this run.
  }
}

function launch() {
  enableCache()
  require('./houston-cli.cjs').runAsEntry()
}

module.exports = { compileCacheDir, enableCache, launch }

if (require.main === module) launch()
