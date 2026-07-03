import { build } from 'esbuild'
import { chmodSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Bundle the standalone CLI (src/cli/index.ts) into a single self-contained
 * Node script: out/cli/houston-cli.cjs. Pure JS — no native modules, no
 * Electron — so ONE artifact runs on every platform with Node >= 22; it ships
 * as a release asset. Unlike the electron-vite main build (which externalizes
 * node_modules into the asar), everything is inlined here: the file must run
 * on a bare server with no node_modules next to it.
 *
 * The metafile guard below is the contract check: `electron` (or the
 * desktop-only electron-updater) reaching this bundle means a shell module
 * leaked into the CLI graph — fail the build rather than ship a bundle that
 * crashes (or silently no-ops) at require time.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outfile = resolve(root, 'out/cli/houston-cli.cjs')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))

const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/cli/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile,
  minify: true,
  metafile: true,
  banner: { js: '#!/usr/bin/env node' },
  define: { __HOUSTON_VERSION__: JSON.stringify(pkg.version) },
  alias: { '@shared': resolve(root, 'src/shared') },
  logLevel: 'info'
})

const offenders = Object.keys(result.metafile.inputs).filter(
  (p) => p === 'electron' || /node_modules\/electron(-updater)?\//.test(p)
)
if (offenders.length > 0) {
  console.error(
    `Electron reached the CLI bundle graph via:\n  ${offenders.join('\n  ')}\n` +
      'The standalone CLI must not depend on electron — wire the capability through a seam instead.'
  )
  process.exit(1)
}

chmodSync(outfile, 0o755)
console.log(`CLI bundle: ${outfile} (v${pkg.version})`)
