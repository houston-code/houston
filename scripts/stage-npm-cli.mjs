// Stage the standalone CLI as the publishable npm package @houston-code/cli.
//
// The repo-root package.json is the Electron app: it is `private`, pulls Electron and a
// native module, and runs electron-rebuild on postinstall, so it can never be what
// `npm i -g` installs. The CLI is one self-contained file (scripts/build-cli.mjs), so the
// npm package is that file plus a generated manifest, the npm-page README, the license
// files, and a small launcher (packaging/npm/houston.cjs) that `houston` runs: it turns on
// Node's compile cache before loading the bundle. Nothing else ships: no dependencies, no
// install scripts.
//
//   node scripts/stage-npm-cli.mjs [--cli out/cli/houston-cli.cjs] [--out out/npm-cli] [--manifest package.json]
//
// --manifest is the package.json the version, Node floor, license and links come from. The
// release workflow passes the release commit's: it runs these scripts from main, whose
// package.json can already be ahead of (or otherwise differ from) what was released.
//
// then `npm publish --provenance --access public` from the output folder. The release
// workflow stages from the houston-cli.cjs it downloaded from the published GitHub Release
// (after checking it against SHA256SUMS), so npm ships the same bytes as the release.
//
// The pure `npmManifest(rootPkg)` is unit-tested.

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isReleaseVersion } from './render-packaging.mjs'

export const PACKAGE_NAME = '@houston-code/cli'
const CLI_FILE = 'houston-cli.cjs'
const LAUNCHER_FILE = 'houston.cjs'

/**
 * Whether the launcher can start this bundle: it calls the bundle's exported startCli. A
 * bundle built before the launcher existed starts only as the main module, and the release
 * workflow stages whichever release is latest with main's copy of this script, so such a
 * bundle is staged the way it always was, with `houston` running it directly.
 */
export function bundleStartsFromLauncher(cliPath) {
  // Requiring the bundle (not running it as the main module) only defines its exports.
  const probe = spawnSync(
    process.execPath,
    ['-e', 'process.stdout.write(typeof require(process.argv[1]).startCli)', cliPath],
    { encoding: 'utf8' }
  )
  return probe.status === 0 && probe.stdout === 'function'
}

/** The published package.json, derived from the root manifest so version and links never drift. */
export function npmManifest(rootPkg, { launcher = true } = {}) {
  if (!isReleaseVersion(rootPkg.version)) {
    throw new Error(`refusing to stage a non-release version: ${rootPkg.version}`)
  }
  return {
    name: PACKAGE_NAME,
    version: rootPkg.version,
    description: 'Houston coding agent in your terminal: bring your own model (Claude, GPT, Gemini, or a local LLM).',
    keywords: ['ai', 'agent', 'coding-agent', 'cli', 'llm', 'claude', 'openai', 'gemini'],
    homepage: 'https://houstoncode.ai',
    repository: rootPkg.repository,
    bugs: rootPkg.bugs,
    license: rootPkg.license,
    author: rootPkg.author,
    bin: { houston: launcher ? LAUNCHER_FILE : CLI_FILE },
    files: launcher ? [LAUNCHER_FILE, CLI_FILE, 'NOTICE'] : [CLI_FILE, 'NOTICE'],
    engines: { node: rootPkg.engines.node },
    // No `provenance: true` here: npm can only generate provenance in CI, so it would break
    // the one-time hand publish. The release workflow passes --provenance itself.
    publishConfig: { access: 'public' },
  }
}

function parseArgs(argv) {
  const opts = { cli: 'out/cli/houston-cli.cjs', out: 'out/npm-cli', manifest: 'package.json' }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (!['--cli', '--out', '--manifest'].includes(flag)) throw new Error(`unknown argument: ${flag}`)
    const value = argv[++i]
    if (!value) throw new Error(`${flag} needs a value`)
    opts[flag.slice(2)] = value
  }
  return opts
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const { cli, out, manifest: manifestPath } = parseArgs(process.argv.slice(2))
  const cliPath = resolve(root, cli)
  const outDir = resolve(root, out)
  if (!existsSync(cliPath)) throw new Error(`${cliPath} not found: run \`npm run build:cli\` first`)
  if (!readFileSync(cliPath, 'utf8').startsWith('#!/usr/bin/env node')) {
    throw new Error(`${cliPath} has no node shebang; npm's bin shim needs one`)
  }

  const launcher = bundleStartsFromLauncher(cliPath)
  const manifest = npmManifest(JSON.parse(readFileSync(resolve(root, manifestPath), 'utf8')), { launcher })
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  copyFileSync(cliPath, join(outDir, CLI_FILE))
  if (launcher) copyFileSync(resolve(root, 'packaging/npm', LAUNCHER_FILE), join(outDir, LAUNCHER_FILE))
  else console.log(`${cliPath} has no startCli export: \`houston\` runs it directly, without the launcher`)
  copyFileSync(resolve(root, 'packaging/npm/README.md'), join(outDir, 'README.md'))
  // npm always packs LICENSE and README; Apache-2.0 also needs NOTICE, listed in `files`.
  copyFileSync(resolve(root, 'LICENSE'), join(outDir, 'LICENSE'))
  copyFileSync(resolve(root, 'NOTICE'), join(outDir, 'NOTICE'))
  console.log(`Staged ${manifest.name}@${manifest.version} in ${outDir}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (err) {
    console.error(`stage-npm-cli: ${err.message}`)
    process.exit(1)
  }
}
