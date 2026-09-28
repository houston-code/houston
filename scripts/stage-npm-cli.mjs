// Stage the standalone CLI as the publishable npm package @houston-code/cli.
//
// The repo-root package.json is the Electron app: it is `private`, pulls Electron and a
// native module, and runs electron-rebuild on postinstall, so it can never be what
// `npm i -g` installs. The CLI is one self-contained file (scripts/build-cli.mjs), so the
// npm package is that file plus a generated manifest, the npm-page README, and the license
// files. Nothing else ships: no dependencies, no install scripts.
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

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isReleaseVersion } from './render-packaging.mjs'

export const PACKAGE_NAME = '@houston-code/cli'
const CLI_FILE = 'houston-cli.cjs'

/** The published package.json, derived from the root manifest so version and links never drift. */
export function npmManifest(rootPkg) {
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
    bin: { houston: CLI_FILE },
    files: [CLI_FILE, 'NOTICE'],
    engines: { node: rootPkg.engines.node },
    publishConfig: { access: 'public', provenance: true },
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

  const manifest = npmManifest(JSON.parse(readFileSync(resolve(root, manifestPath), 'utf8')))
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  copyFileSync(cliPath, join(outDir, CLI_FILE))
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
