#!/usr/bin/env node
// Decide which `package` legs a CI run needs, whether the GitHub Action's end-to-end test
// runs, and whether a push to main must refresh the package caches. ci.yml's `plan` job runs
// this and feeds its output to `package`, `action-e2e`, `warm-caches` and the required
// `build` gate.
//
// Why it exists: the macOS runner pool is the scarce resource. With the full four-leg matrix
// on every PR and every merge-queue candidate, a burst of PRs queued ~80 macOS jobs; queue
// candidates waited behind PR runs for most of an hour, and the queue ejects an entry whose
// checks take longer than its timeout. So:
//
//   - pull_request: Linux packaging only. The merge queue runs the native legs on the exact
//     tree that lands, so nothing reaches main without them; a PR that wants them earlier
//     takes the `full-ci` label (which re-triggers CI) and gets all four.
//   - merge_group: Linux, macOS arm64 and Windows.
//   - schedule (nightly, on main): all four, including macOS Intel. Intel shares arm64's
//     code and unit suite; what it alone covers is the x64 build, which nightly and every
//     release (release-prepare/publish build it too) still exercise.
//   - A change that touches only prose that never ships (PROSE_ONLY) needs no packaging at
//     all. `test`, `linux-sandbox` and `revert-guard` still run on it, and `build` still
//     reports: it accepts a skipped `package` only when this plan said to skip it.
//
// The action's end-to-end test (action-test.yml, about 20 seconds) runs when a change can
// affect the action (ACTION_INPUTS), and nightly. `build` requires it then, so a change
// that breaks the action can't merge on the strength of the other checks.
//
// Anything unrecognised (an unknown event, a missing diff) gets the full matrix and the
// action test: the safe failure is more CI, never less.
//
// Usage (in CI): EVENT=<github.event_name> LABELS=<json array> FILES_FROM=<path|""> \
//   node scripts/ci-plan.mjs >> "$GITHUB_OUTPUT"

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// Keep the runner labels in lockstep with the release workflows' legs, so CI == shipped.
export const LEGS = {
  // Pinned to ubuntu-22.04 (NOT ubuntu-latest): the native node-pty addon is compiled here,
  // so the runner's glibc sets the shipped app's minimum glibc. 22.04 = glibc 2.35, the
  // documented Linux floor (README).
  'linux-x64': { target: 'linux-x64', os: 'ubuntu-22.04', dist: 'dist:linux' },
  'mac-arm64': { target: 'mac-arm64', os: 'macos-15', dist: 'dist:mac' },
  // GitHub's Intel (x64) runner, the only place the x64 mac app builds natively. GitHub
  // sunsets x64 macOS runners after macos-15 (~Fall 2027), at which point Intel needs a
  // universal-on-arm64 build or gets dropped.
  'mac-x64': { target: 'mac-x64', os: 'macos-15-intel', dist: 'dist:mac:x64' },
  'win-x64': { target: 'win-x64', os: 'windows-2025', dist: 'dist:win' }
}

const ALL = ['linux-x64', 'mac-arm64', 'mac-x64', 'win-x64']
const QUEUE = ['linux-x64', 'mac-arm64', 'win-x64']
const PR = ['linux-x64']

export const FULL_CI_LABEL = 'full-ci'

// Prose that never reaches the app, a test, or a build. Deliberately an allowlist of named
// files and folders rather than "*.md": docs/houston-guide.md is inlined into the app,
// CHANGELOG.md feeds the release highlights, and LICENSE / NOTICE / TRADEMARK.md /
// THIRD-PARTY-NOTICES.md are packaged and checked by the e2e. website/ is the static site,
// never bundled; brand-carve-out.test.mjs reads website/public, but that test runs in
// `test`, which never skips.
const PROSE_FILES = new Set([
  'README.md',
  'ROADMAP.md',
  'AGENTS.md',
  'CLAUDE.md',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'SECURITY.md'
])
const SHIPPED_DOCS = new Set(['docs/houston-guide.md'])

/** True when `file` is prose that no package leg can be affected by. */
export function isProseOnly(file) {
  if (PROSE_FILES.has(file)) return true
  if (file.startsWith('website/')) return true
  if (file.startsWith('docs/') && file.endsWith('.md') && !SHIPPED_DOCS.has(file)) return true
  return false
}

// What `warm-caches` puts in the caches is keyed on package-lock.json (setup-node's npm and
// Electron caches) and shaped by the Node version, the setup action and electron-builder's
// tool downloads. Any other merge leaves the main-scoped entries exactly as they were.
const CACHE_INPUTS = ['package-lock.json', '.nvmrc', 'electron-builder.yml']
const CACHE_INPUT_DIRS = ['.github/actions/setup-node/']

/** True when a push changing `files` would change what `warm-caches` saves. */
export function touchesCacheInputs(files) {
  return files.some((f) => CACHE_INPUTS.includes(f) || CACHE_INPUT_DIRS.some((d) => f.startsWith(d)))
}

// What the action's end-to-end test exercises: the action itself, the key it verifies the
// CLI with, and the workflow that runs it.
const ACTION_INPUTS = ['houston-signing-key.asc', '.github/workflows/action-test.yml']

/** True when one of `files` can change how the GitHub Action behaves. */
export function touchesAction(files) {
  return files.some((f) => f.startsWith('action/') || ACTION_INPUTS.includes(f))
}

/**
 * @param {{ event: string, labels?: string[], files?: string[] | null }} input
 *   files: the changed paths, or null when the diff could not be computed.
 * @returns {{ legs: string[], actionE2e: boolean, warmCaches: boolean }}
 */
export function plan({ event, labels = [], files = null }) {
  const proseOnly = Array.isArray(files) && files.length > 0 && files.every(isProseOnly)

  if (event === 'push') {
    // `package` never runs on push (the queue candidate already packaged the tree that
    // landed), nor does the action test; a push only decides whether to refresh the caches.
    return { legs: [], actionE2e: false, warmCaches: !Array.isArray(files) || touchesCacheInputs(files) }
  }
  const actionE2e = event === 'schedule' || !Array.isArray(files) || touchesAction(files)
  if (event === 'schedule') return { legs: ALL, actionE2e, warmCaches: false }
  if (proseOnly) return { legs: [], actionE2e, warmCaches: false }
  if (event === 'pull_request') {
    return { legs: labels.includes(FULL_CI_LABEL) ? ALL : PR, actionE2e, warmCaches: false }
  }
  if (event === 'merge_group') return { legs: QUEUE, actionE2e, warmCaches: false }
  return { legs: ALL, actionE2e, warmCaches: false }
}

/** The plan as GITHUB_OUTPUT lines. */
export function outputs({ legs, actionE2e, warmCaches }) {
  return [
    `package=${legs.length > 0}`,
    `package-matrix=${JSON.stringify({ include: legs.map((l) => LEGS[l]) })}`,
    `action-e2e=${actionE2e}`,
    `warm-caches=${warmCaches}`
  ].join('\n')
}

function main() {
  const event = process.env.EVENT ?? ''
  // toJSON() of a missing PR's labels is `null`, not `[]`.
  let labels = []
  try {
    const parsed = JSON.parse(process.env.LABELS || '[]')
    if (Array.isArray(parsed)) labels = parsed
  } catch {
    labels = []
  }
  let files = null
  if (process.env.FILES_FROM) {
    try {
      files = readFileSync(process.env.FILES_FROM, 'utf8').split('\n').filter(Boolean)
    } catch {
      files = null
    }
  }
  const result = plan({ event, labels, files })
  console.error(`event=${event} labels=${JSON.stringify(labels)} files=${files ? files.length : 'unknown'} -> legs=[${result.legs}] action-e2e=${result.actionE2e} warm-caches=${result.warmCaches}`)
  console.log(outputs(result))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
