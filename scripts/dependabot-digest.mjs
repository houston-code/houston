#!/usr/bin/env node
// Weekly digest of Dependabot PRs whose CI is red, filed as one GitHub issue.
//
// WHY THIS EXISTS — a Dependabot PR's CI failure notifies nobody. GitHub mails a workflow
// run's *triggering actor*, and for a Dependabot PR that actor is dependabot[bot], which has
// no inbox. Measured on this repo: of 97 CI runs on Dependabot PRs, 17 failed and no one was
// told. The effect is quiet rather than dramatic — a red PR just sits unmerged and the
// dependency silently stops updating. Same root cause as the scheduled-workflow gap that
// alert-on-failure.yml covers (see that file); this is the other half of it.
//
// WHY A DIGEST, NOT AN ALERT PER FAILURE — Dependabot opens its PRs in weekly batches
// (.github/dependabot.yml: interval: weekly), so a bad batch would file five issues on one
// morning and nothing for the rest of the week. That is how an alert teaches you to ignore
// it. One issue, once a week, listing every Dependabot PR currently red; nothing at all when
// they are green.
//
// The digest reports the CURRENT state rather than a log of events, so it is stateless: it
// re-reads the open PRs on every run and rewrites the picture. A PR that goes green simply
// stops appearing, and the issue closes itself once none are left.
//
// Usage:  node scripts/dependabot-digest.mjs
// Env:    GH_TOKEN (issues: write, pull-requests: read), GH_REPO, OWNER, RUN_URL
// Exit 0 on success; non-zero only on a real error (a broken query), which the caller's
// alert job then surfaces the same way as any other red scheduled workflow.

import { execFileSync } from 'node:child_process'

/** Title of the digest issue. Also its dedupe key — one open digest at a time. */
export const TITLE = 'Dependabot PRs are failing CI'
/** Its own label, so this can never be confused with (or closed by) an alert-on-failure issue. */
export const LABEL = 'dependabot-digest'

// A check "fails" only when it reached a conclusive bad end. CANCELLED is deliberately NOT a
// failure: concurrency cancels runs routinely (16 of the Dependabot runs measured were
// cancelled, not broken), and reporting those would bury the real ones. Neither is a check
// still queued or in progress — it has not failed yet, it just has not finished.
const FAILING_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED'])
const FAILING_STATES = new Set(['FAILURE', 'ERROR'])

/**
 * Whether a single entry of a PR's statusCheckRollup is a failure. The rollup mixes two node
 * types: a CheckRun carries `conclusion` (and an empty one while still running), a legacy
 * StatusContext carries `state` instead. Read whichever is present.
 */
export function checkFails(check) {
  if (check.conclusion) return FAILING_CONCLUSIONS.has(check.conclusion)
  if (check.state) return FAILING_STATES.has(check.state)
  return false
}

/** Whether any of a PR's checks failed. A PR with no checks at all is not failing. */
export function isFailing(pr) {
  return (pr.statusCheckRollup ?? []).some(checkFails)
}

/** The open Dependabot PRs whose CI is red, in stable PR-number order. */
export function failingPrs(prs) {
  return prs.filter(isFailing).sort((a, b) => a.number - b.number)
}

/** The markdown body/comment: what is red right now, and where to look. */
export function digestBody(failing, runUrl) {
  const n = failing.length
  const lines = failing.map((pr) => `- [#${pr.number}](${pr.url}) — ${pr.title}`)
  return [
    `**${n} Dependabot ${n === 1 ? 'PR is' : 'PRs are'} failing CI.**`,
    '',
    ...lines,
    '',
    `Checked by ${runUrl}`,
    '',
    'GitHub does not mail anyone about these: a workflow run notifies its triggering actor,',
    'and for a Dependabot PR that is `dependabot[bot]`. This digest is how they surface.',
    '',
    'It rewrites itself weekly with whatever is red at the time, and closes itself once every',
    'Dependabot PR is green again, so there is no need to tend it by hand.'
  ].join('\n')
}

/**
 * What to do with the digest issue, given what is red and whether one is already open.
 * Kept separate from the gh calls so every branch is unit-testable.
 */
export function plan(failing, existingIssue) {
  if (failing.length === 0) return existingIssue ? { action: 'close' } : { action: 'none' }
  return existingIssue ? { action: 'comment' } : { action: 'create' }
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8' })
}

function main() {
  const repo = process.env.GH_REPO
  const owner = process.env.OWNER
  const runUrl = process.env.RUN_URL ?? ''
  if (!repo || !owner) {
    console.error('::error::GH_REPO and OWNER must be set.')
    process.exit(2)
  }

  // `app/dependabot` is how gh addresses a GitHub App author. statusCheckRollup rides along
  // with the PR list, so this is one API round-trip rather than one per PR.
  const prs = JSON.parse(
    gh([
      'pr',
      'list',
      '--repo',
      repo,
      '--author',
      'app/dependabot',
      '--state',
      'open',
      '--limit',
      '100',
      '--json',
      'number,title,url,statusCheckRollup'
    ])
  )
  const failing = failingPrs(prs)

  const open = JSON.parse(
    gh(['issue', 'list', '--repo', repo, '--label', LABEL, '--state', 'open', '--limit', '100', '--json', 'number,title'])
  )
  const existing = open.find((i) => i.title === TITLE)

  const { action } = plan(failing, existing)
  console.log(`${prs.length} open Dependabot PRs, ${failing.length} red -> ${action}`)

  if (action === 'none') return
  if (action === 'close') {
    gh(['issue', 'close', String(existing.number), '--repo', repo, '--comment', `All Dependabot PRs are green again as of ${runUrl} — closing.`])
    console.log(`Closed #${existing.number}.`)
    return
  }
  if (action === 'comment') {
    gh(['issue', 'comment', String(existing.number), '--repo', repo, '--body', digestBody(failing, runUrl)])
    console.log(`Updated #${existing.number}.`)
    return
  }
  // --label needs the label to exist; --force makes this both the bootstrap and a no-op later.
  gh(['label', 'create', LABEL, '--repo', repo, '--color', 'D93F0B', '--description', 'Weekly digest: Dependabot PRs with failing CI', '--force'])
  // Assigned, because assignment notifies unconditionally — the whole point.
  gh(['issue', 'create', '--repo', repo, '--label', LABEL, '--assignee', owner, '--title', TITLE, '--body', digestBody(failing, runUrl)])
  console.log('Opened the digest issue.')
}

// Only run when invoked as a script, so the tests can import the pure helpers above.
if (process.argv[1] && process.argv[1].endsWith('dependabot-digest.mjs')) main()
