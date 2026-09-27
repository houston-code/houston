// Make sure a release run uploads into exactly ONE draft GitHub Release for its tag.
//
// Why this is needed: electron-builder's github publisher creates the release lazily, from
// each target's upload. On the arm64 mac leg the zip and dmg targets publish concurrently;
// both looked up v0.3.0, both saw "release doesn't exist", and both created a draft in the
// same second. The assets then split across two drafts (electron-builder later found one,
// `gh release upload "$tag"` resolved the other), and the Intel leg's
// `gh release download -p latest-mac.yml` hit the draft without the feed and failed.
// Creating the draft up front means electron-builder always finds it and never creates one.
//
//   ensure <repo> <tag> <sha>  create the draft if none exists, reuse a single existing
//                              draft (a re-run), and fail on anything else
//   check  <repo> <tag>        fail unless exactly one draft exists for the tag
//
// The pure `planReleaseDraft(releases, tag)` is unit-tested without any I/O.

import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Decide what to do given every release in the repo (drafts included) and the tag this run
 * publishes. Returns `{ action: 'create' }`, `{ action: 'reuse', id }`, or
 * `{ action: 'error', message }`.
 */
export function planReleaseDraft(releases, tag) {
  const matches = releases.filter((r) => r.tag_name === tag)
  if (matches.length === 0) return { action: 'create' }
  if (matches.length > 1) {
    const ids = matches.map((r) => `${r.id}${r.draft ? ' (draft)' : ''}`).join(', ')
    return {
      action: 'error',
      message: `${matches.length} releases exist for ${tag} (${ids}). Assets would split between them; delete the extras (or all of them) and re-run.`,
    }
  }
  const [only] = matches
  if (!only.draft) {
    return {
      action: 'error',
      message: `${tag} is already published (release ${only.id}); bump the version instead of re-publishing it.`,
    }
  }
  return { action: 'reuse', id: only.id }
}

function gh(args) {
  // execFileSync with an argv array: no shell, so tag/sha values can't inject anything.
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
}

function listReleases(repo) {
  // The list endpoint (unlike /releases/tags/{tag}) includes drafts. --jq runs per page, so
  // each release comes out as one JSON line regardless of pagination.
  const out = gh([
    'api',
    '--paginate',
    `repos/${repo}/releases?per_page=100`,
    '--jq',
    '.[] | {id, tag_name, draft}',
  ])
  return out
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
}

function fail(message) {
  console.error(`::error::${message}`)
  process.exit(1)
}

function main(argv) {
  const [mode, repo, tag, sha] = argv
  if (!repo || !tag || (mode === 'ensure' && !sha) || (mode !== 'ensure' && mode !== 'check')) {
    console.error('usage: node scripts/release-draft.mjs ensure <owner/repo> <tag> <sha>')
    console.error('       node scripts/release-draft.mjs check  <owner/repo> <tag>')
    process.exit(2)
  }

  const plan = planReleaseDraft(listReleases(repo), tag)
  if (plan.action === 'error') fail(plan.message)

  if (mode === 'check') {
    if (plan.action !== 'reuse') fail(`no draft release exists for ${tag}.`)
    console.log(`One draft release for ${tag} (${plan.id}).`)
    return
  }

  if (plan.action === 'reuse') {
    console.log(`Reusing the existing draft release for ${tag} (${plan.id}).`)
    return
  }

  // Title matches what electron-builder would name it (the bare version), so the finished
  // release looks the same as before. The tag itself is only created when finalize publishes.
  gh([
    'release', 'create', tag,
    '-R', repo,
    '--draft',
    '--title', tag.replace(/^v/, ''),
    '--target', sha,
    '--notes', '',
  ])
  // Re-read so a concurrent creator (which shouldn't exist, but this bug was a race) is
  // caught here rather than as missing assets several steps later.
  const after = planReleaseDraft(listReleases(repo), tag)
  if (after.action !== 'reuse') fail(after.message ?? `draft release for ${tag} did not appear after creating it.`)
  console.log(`Created the draft release for ${tag} (${after.id}).`)
}

// Run only when invoked directly, not when imported by the unit test.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
