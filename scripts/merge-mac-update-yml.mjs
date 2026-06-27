// Merge two electron-updater `latest-mac.yml` feeds (arm64 + x64) into one that lists
// BOTH architectures' files, so a single published feed auto-updates both.
//
// Why this is needed: arm64 and x64 build on separate runners and each emits its own
// `latest-mac.yml`; publishing both clobbers one (electron-builder#5592). electron-updater
// (MacUpdater.filterFilesForArch) selects per-arch from the `files` array by matching
// "arm64" in each file's URL — arm64 Macs keep the arm64 entries, x64 Macs keep the rest.
// So a feed whose `files` array contains both arches' entries Just Works for everyone;
// `getFileList` reads `files` (the top-level `path`/`sha512` are a legacy single-file
// fallback, irrelevant to clients that understand `files`).
//
// The pure `mergeMacUpdateYml(armText, x64Text)` is unit-tested without any I/O.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

/** True when a file entry targets arm64, by the same rule MacUpdater uses (URL contains "arm64"). */
export function isArm64File(file) {
  return typeof file?.url === 'string' && file.url.includes('arm64')
}

/**
 * Merge an arm64 feed (the base — it owns version/path/releaseDate) with an x64 feed,
 * producing a single feed whose `files` lists both arches. Throws on a version mismatch
 * (the two builds must be the same release) or if either side is missing arch-appropriate
 * files (a guard against silently shipping a feed that can't update one architecture).
 */
export function mergeMacUpdateYml(armText, x64Text) {
  const arm = yaml.load(armText)
  const x64 = yaml.load(x64Text)

  if (!arm || !Array.isArray(arm.files)) throw new Error('arm64 latest-mac.yml has no `files` array')
  if (!x64 || !Array.isArray(x64.files)) throw new Error('x64 latest-mac.yml has no `files` array')
  if (arm.version !== x64.version) {
    throw new Error(`version mismatch: arm64=${arm.version} x64=${x64.version} — the two builds are not the same release`)
  }

  const armFiles = arm.files.filter(isArm64File)
  const x64Files = x64.files.filter((f) => !isArm64File(f))
  if (armFiles.length === 0) throw new Error('arm64 feed lists no arm64 files (nothing for Apple Silicon to update to)')
  if (x64Files.length === 0) throw new Error('x64 feed lists no x64 files (nothing for Intel to update to)')

  // Dedupe by URL, arm64 first (so the base's entries win on any collision).
  const merged = []
  const seen = new Set()
  for (const f of [...armFiles, ...x64Files]) {
    if (seen.has(f.url)) continue
    seen.add(f.url)
    merged.push(f)
  }

  // Keep the arm64 base's top-level fields (version, path, sha512, releaseDate); only the
  // `files` array changes. lineWidth:-1 keeps long base64 sha512 scalars on one line.
  return yaml.dump({ ...arm, files: merged }, { lineWidth: -1 })
}

function main(argv) {
  const [armPath, x64Path] = argv
  if (!armPath || !x64Path) {
    console.error('usage: node scripts/merge-mac-update-yml.mjs <arm64-latest-mac.yml> <x64-latest-mac.yml>')
    process.exit(2)
  }
  process.stdout.write(mergeMacUpdateYml(readFileSync(armPath, 'utf8'), readFileSync(x64Path, 'utf8')))
}

// Run only when invoked directly, not when imported by the unit test.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
