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
// The pure `planReleaseDraft(releases, tag)` and `waitUntilListed(...)` are unit-tested
// without any I/O.

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

/**
 * Wait for the draft we just created (`id`) to show up in the release list. The list
 * endpoint lags a new release by a few seconds, and electron-builder finds the draft
 * through that same list, so packaging before it is listed would let electron-builder
 * create a second draft: the bug this script exists to prevent. Returns the settled
 * plan: `{ action: 'reuse', id }` once exactly our draft is listed, or an error (a
 * duplicate appeared, or it never showed up within `attempts`).
 */
export async function waitUntilListed(list, tag, id, { attempts = 10, delayMs = 3000, sleep = defaultSleep } = {}) {
  for (let i = 0; i < attempts; i++) {
    const plan = planReleaseDraft(list(), tag)
    if (plan.action === 'error') return plan
    if (plan.action === 'reuse' && plan.id === id) return plan
    // Not listed yet (or only a different draft is, which the next read turns into a
    // duplicate error once ours appears).
    if (i < attempts - 1) await sleep(delayMs)
  }
  return {
    action: 'error',
    message: `draft release ${id} for ${tag} did not appear in the release list after ${(attempts * delayMs) / 1000}s.`,
  }
}

/**
 * gh argv that points an existing draft release at `sha`. `tag_name` MUST be resent: a
 * draft's tag does not exist until finalize publishes it, and a PATCH that omits it makes
 * GitHub rename the draft's tag to `untagged-<hash>`. electron-builder then cannot find the
 * draft by tag and creates a second one (the v0.4.0 re-run left two drafts this way).
 */
export function retargetArgs(repo, id, tag, sha) {
  return [
    'api', '-X', 'PATCH', `repos/${repo}/releases/${id}`,
    '-f', `tag_name=${tag}`,
    '-f', `target_commitish=${sha}`,
    '--silent',
  ]
}

function defaultSleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
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

async function main(argv) {
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
    // The draft may be left from an earlier, failed run, pointing at that run's commit.
    // Retarget it at the commit this run builds, so the release's target_commitish names
    // what actually shipped (finalize tags this same commit).
    gh(retargetArgs(repo, plan.id, tag, sha))
    // Confirm the draft is still listed under the tag after the edit, which is how
    // electron-builder finds it; otherwise it would quietly create a second draft.
    const after = await waitUntilListed(() => listReleases(repo), tag, plan.id)
    if (after.action === 'error') fail(after.message)
    console.log(`Reusing the existing draft release for ${tag} (${plan.id}), retargeted at ${sha}.`)
    return
  }

  // Created through the API (not `gh release create`) so we get its id back. Title matches
  // what electron-builder would name it (the bare version), so the finished release looks
  // the same as before. The tag itself is only created when finalize publishes.
  const created = JSON.parse(
    gh([
      'api', '-X', 'POST', `repos/${repo}/releases`,
      '-f', `tag_name=${tag}`,
      '-f', `name=${tag.replace(/^v/, '')}`,
      '-f', `target_commitish=${sha}`,
      '-f', 'body=',
      '-F', 'draft=true',
    ]),
  )
  console.log(`Created draft release ${created.id} for ${tag}; waiting for it to be listed.`)
  // Also catches a concurrent creator (which shouldn't exist, but this bug was a race)
  // here rather than as missing assets several steps later.
  const after = await waitUntilListed(() => listReleases(repo), tag, created.id)
  if (after.action === 'error') fail(after.message)
  console.log(`Draft release ${after.id} for ${tag} is listed.`)
}

// Run only when invoked directly, not when imported by the unit test.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => fail(err?.message ?? String(err)))
}
