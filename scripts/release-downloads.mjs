// Build the "Download" table that heads each GitHub Release's notes.
//
// A release carries dozens of files (installers, update feeds, signatures, provenance,
// SBOMs) and GitHub lists them flat, with no folders. This table gives each platform one
// row linking its installer, so a visitor doesn't have to pick through the asset list. It
// is built from the draft's actual asset names, so a link can't point at a file that
// isn't there, and it fails if a platform's installer is missing.
//
//   node scripts/release-downloads.mjs <owner/repo> <tag>   prints the markdown
//
// The pure `downloadsTable(names, repo, tag)` is unit-tested without any I/O.
// Everything it prints is customer-facing: no em dashes.

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { draftAssetNames } from './release-checksums.mjs'

// [platform, requirement note, ...matchers]; each matcher must hit exactly one asset.
const ROWS = [
  ['macOS, Apple Silicon', 'macOS 13 Ventura or newer. Open the .dmg and drag Houston to Applications.', (n) => n.endsWith('-arm64.dmg')],
  ['macOS, Intel', 'macOS 13 Ventura or newer. Open the .dmg and drag Houston to Applications.', (n) => n.endsWith('-x64.dmg')],
  [
    'Windows, x64',
    'Windows 10 or newer. Per-user install, no admin needed. Not code-signed yet: in the SmartScreen prompt choose More info, then Run anyway.',
    (n) => n.endsWith('-x64-setup.exe'),
  ],
  [
    'Linux, x64',
    'glibc 2.35 or newer (Ubuntu 22.04+). The AppImage shows a banner when a new version is out. The .deb does not check, so download new versions yourself.',
    (n) => n.endsWith('.AppImage'),
    (n) => n.endsWith('.deb'),
  ],
  [
    'Terminal CLI: macOS, Windows, Linux',
    'Node 22 or newer, on x64 or Arm. Run `node houston-cli.cjs --help` to start.',
    (n) => n === 'houston-cli.cjs',
  ],
]

function link(repo, tag, name) {
  return `[${name}](https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)})`
}

/** The markdown table (plus a verification line) for a release whose assets are `names`. */
export function downloadsTable(names, repo, tag) {
  const lines = ['## Download', '', '| Platform | File | Requirements |', '| --- | --- | --- |']
  const missing = []
  for (const [platform, note, ...matchers] of ROWS) {
    const files = matchers.map((matches) => names.filter(matches))
    if (files.some((hits) => hits.length !== 1)) {
      missing.push(platform)
      continue
    }
    lines.push(`| ${platform} | ${files.map(([name]) => link(repo, tag, name)).join('<br>')} | ${note} |`)
  }
  if (missing.length) throw new Error(`no single installer on the release for: ${missing.join(', ')}`)

  lines.push('')
  if (names.includes('SHA256SUMS')) {
    lines.push(
      `To check a download, compare it against ${link(repo, tag, 'SHA256SUMS')}, which is signed with GPG and cosign. ` +
        `[Verifying downloads](https://github.com/${repo}#verifying-downloads) has the steps.`,
      '',
    )
  }
  lines.push(
    'The other files below are the auto-update feeds, signatures, build provenance and SBOMs. You do not need them to install Houston.',
  )
  return lines.join('\n') + '\n'
}

function main(argv) {
  const [repo, tag] = argv
  if (!repo || !tag) {
    console.error('usage: node scripts/release-downloads.mjs <owner/repo> <tag>')
    process.exit(2)
  }
  try {
    process.stdout.write(downloadsTable(draftAssetNames(repo, tag), repo, tag))
  } catch (err) {
    console.error(`::error::${err.message}`)
    process.exit(1)
  }
}

// Run only when invoked directly, not when imported by the unit test.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
