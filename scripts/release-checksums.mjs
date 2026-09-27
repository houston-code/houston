// Pick the release assets that belong in the whole-release SHA256SUMS manifest.
//
// The manifest used to be built on the Linux leg from the files on that runner, so it only
// covered the Linux installers, the CLI and the SBOMs: a mac or Windows download could not
// be checked against it, though the README says `sha256sum -c SHA256SUMS` verifies the
// release. It is now built by the release workflow's `checksums` job, after every build leg
// has uploaded, from the draft release itself: this script lists what to hash, the job
// downloads exactly those files, and hashes what a user actually downloads.
//
//   node scripts/release-checksums.mjs <owner/repo> <tag>
//
// prints one asset name per line, and exits 1 if the draft is missing any platform's
// installer (a leg that silently uploaded nothing must not yield a "complete" manifest).
//
// The pure `checksummedAssets(names)` and `missingRequired(names)` are unit-tested.

import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { planReleaseDraft } from './release-draft.mjs'

// Signatures, provenance, updater metadata and per-file checksums describe other assets
// and are verified through them, so they are not listed themselves.
const EXCLUDED_SUFFIXES = ['.cosign.bundle', '.slsa.bundle', '.asc', '.blockmap', '.yml', '.sha256']
const EXCLUDED_NAMES = new Set(['SHA256SUMS'])

// One entry per download the manifest must cover. Matched loosely on the arch/format part
// of the name so a version or naming tweak elsewhere doesn't break the release.
export const REQUIRED = [
  ['macOS arm64 dmg', (n) => n.endsWith('-arm64.dmg')],
  ['macOS x64 dmg', (n) => n.endsWith('-x64.dmg')],
  ['macOS arm64 zip', (n) => n.endsWith('-arm64-mac.zip')],
  ['macOS x64 zip', (n) => n.endsWith('-mac.zip') && !n.includes('arm64')],
  ['Windows installer', (n) => n.endsWith('-x64-setup.exe')],
  ['Linux AppImage', (n) => n.endsWith('.AppImage')],
  ['Linux deb', (n) => n.endsWith('.deb')],
  ['standalone CLI', (n) => n === 'houston-cli.cjs'],
  ['dependency SBOM', (n) => n === 'sbom.cyclonedx.json'],
  ...['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64'].map((label) => [
    `${label} binary SBOM`,
    (n) => n === `sbom.binary.${label}.cyclonedx.json`,
  ]),
]

/** The asset names SHA256SUMS lists, sorted so the manifest is stable across re-runs. */
export function checksummedAssets(names) {
  return names
    .filter((n) => !EXCLUDED_NAMES.has(n) && !EXCLUDED_SUFFIXES.some((s) => n.endsWith(s)))
    .sort()
}

/** Labels of REQUIRED downloads that no asset satisfies. */
export function missingRequired(names) {
  return REQUIRED.filter(([, matches]) => !names.some(matches)).map(([label]) => label)
}

function gh(args) {
  // execFileSync with an argv array: no shell, so tag/repo values can't inject anything.
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
}

function fail(message) {
  console.error(`::error::${message}`)
  process.exit(1)
}

/**
 * Asset names on the single draft release for `tag`. Exits the process (with a workflow
 * error) if there is no draft or more than one release for the tag. Shared with
 * release-downloads.mjs.
 */
export function draftAssetNames(repo, tag) {
  // The list endpoint includes drafts (the release is still one while this runs).
  const releases = gh(['api', '--paginate', `repos/${repo}/releases?per_page=100`, '--jq', '.[] | {id, tag_name, draft}'])
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
  const plan = planReleaseDraft(releases, tag)
  if (plan.action === 'error') fail(plan.message)
  if (plan.action !== 'reuse') fail(`no draft release exists for ${tag}.`)

  return gh(['api', '--paginate', `repos/${repo}/releases/${plan.id}/assets?per_page=100`, '--jq', '.[].name'])
    .split('\n')
    .filter((line) => line.trim())
}

function main(argv) {
  const [repo, tag] = argv
  if (!repo || !tag) {
    console.error('usage: node scripts/release-checksums.mjs <owner/repo> <tag>')
    process.exit(2)
  }

  const names = draftAssetNames(repo, tag)

  const missing = missingRequired(names)
  if (missing.length) fail(`the ${tag} draft is missing: ${missing.join(', ')}.`)

  const listed = checksummedAssets(names)
  // `gh release download -p` takes a glob; asset names never contain glob characters, but
  // refuse rather than let one match (and hash) a different file.
  const globby = listed.filter((n) => /[*?[\]]/.test(n))
  if (globby.length) fail(`asset names contain glob characters: ${globby.join(', ')}`)
  process.stdout.write(listed.join('\n') + '\n')
}

// Run only when invoked directly, not when imported by the unit test.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
