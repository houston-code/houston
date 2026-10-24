// Point the GitHub Action at a released CLI: set action/cli-release.json to the release's
// version and houston-cli.cjs hash, and add that release's SHA256SUMS and SHA256SUMS.asc
// under action/test/fixtures/v<version>/ (verify.test.mjs checks the pinned hash against
// them).
//
//   node scripts/pin-action-cli.mjs --version X.Y.Z --dir <downloaded release assets>
//
// <dir> holds houston-cli.cjs, SHA256SUMS and SHA256SUMS.asc from the release. They go
// through the action's own check (action/lib/verify.mjs: gpgv against the committed key
// only, then the CLI against its SHA256SUMS line) before anything is written, so the pin
// can only record a file the project key signed for. A version at or behind the current
// pin changes nothing, so a patch to an older release line never moves the action back.
//
// Release - publish's sync-main job runs it for the latest release and carries the result
// to main in the sync PR, where action-test.yml runs the action end to end on the new CLI.
// `pinActionCli({ root, version, dir, run })` is unit-tested, with gpg faked.

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exec } from '../action/lib/exec.mjs'
import { parseVersion, verifyRelease } from '../action/lib/verify.mjs'
import { compareVersions } from './release-source.mjs'

const PIN = 'action/cli-release.json'

/**
 * Pin `version` from the verified assets in `dir`. Resolves to `{ changed: false, pinned }`
 * when the current pin is already at or past it, else `{ changed: true, sha256 }`.
 */
export async function pinActionCli({ root, version, dir, run }) {
  const v = parseVersion(version)
  const current = JSON.parse(readFileSync(join(root, PIN), 'utf8'))
  if (compareVersions(current.version, v) >= 0) return { changed: false, pinned: current.version }

  const gnupgHome = mkdtempSync(join(tmpdir(), 'pin-action-cli-'))
  let sha256
  try {
    ;({ sha256 } = await verifyRelease({
      dir,
      version: v,
      pinned: null,
      keyPath: join(root, 'houston-signing-key.asc'),
      gnupgHome,
      run,
      hasCosign: false
    }))
  } finally {
    rmSync(gnupgHome, { recursive: true, force: true })
  }

  const fixture = join(root, 'action/test/fixtures', `v${v}`)
  mkdirSync(fixture, { recursive: true })
  for (const name of ['SHA256SUMS', 'SHA256SUMS.asc']) copyFileSync(join(dir, name), join(fixture, name))
  writeFileSync(join(root, PIN), `${JSON.stringify({ version: v, sha256 }, null, 2)}\n`)
  return { changed: true, sha256 }
}

function parseArgs(argv) {
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (!['--version', '--dir'].includes(flag)) throw new Error(`unknown argument: ${flag}`)
    const value = argv[++i]
    if (!value) throw new Error(`${flag} needs a value`)
    opts[flag.slice(2)] = value
  }
  if (!opts.version || !opts.dir) throw new Error('usage: pin-action-cli.mjs --version X.Y.Z --dir <assets>')
  return opts
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  try {
    const { version, dir } = parseArgs(process.argv.slice(2))
    const res = await pinActionCli({ root, version, dir: resolve(dir), run: exec })
    console.log(
      res.changed
        ? `Pinned the action to the ${version} CLI (${res.sha256}).`
        : `The action already pins ${res.pinned}; left it alone.`
    )
  } catch (err) {
    console.error(`pin-action-cli: ${err.message}`)
    process.exit(1)
  }
}
