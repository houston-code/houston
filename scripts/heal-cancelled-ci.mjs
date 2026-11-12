#!/usr/bin/env node
// Re-runs a PR's CI when the newest CI run on its head commit was cancelled, which otherwise
// leaves the PR unable to merge, permanently and silently.
//
// THE FAILURE THIS CLOSES. GitHub judges a PR's required checks (`test`, `linux-sandbox`,
// `build`, `revert-guard`) from the NEWEST check suite each workflow has on the head commit,
// not from the best result any suite reported. ci.yml runs on `opened` and `labeled`, and
// Dependabot labels a PR in the same second it opens it, so one PR starts two or three CI
// runs at once. The `ci-<PR>` concurrency group keeps one and cancels the rest, but the
// order runs enter the group is not the order their suites were created. When the run that
// survives is not the newest suite, the newest suite is a cancelled run with no jobs in it.
// GitHub then reports all four required checks as "expected" forever, even though a sibling
// run on the same commit passed every one. Auto-merge never enqueues, a manual enqueue is
// refused ("4 of 4 required status checks are expected"), and re-running the green run does
// not help because it is not the newest suite. PRs #558 and #577 each sat for days this way.
//
// THE FIX. Re-run that newest cancelled run. Its suite then holds real check results, and
// the PR's merge state follows them. Nothing is re-run while any CI run on the commit is
// still going (it may yet be the one that counts, and a re-run would cancel it through the
// concurrency group), nor when the newest run reached a real result, nor for any commit
// that is no longer a PR's head.
//
// A run is re-run at most MAX_ATTEMPTS - 1 times, so a run someone cancels on purpose, or
// one that keeps getting cancelled, cannot loop. Past that it is reported as a warning.
//
// Usage:  node scripts/heal-cancelled-ci.mjs
// Env:    GH_TOKEN (actions: write, pull-requests: read), GH_REPO
//         HEAD_SHA (optional): check only the open PR whose head is this commit. Set when a
//           CI run finishing triggers this, so it looks at that run's PR instead of all of them.
//         SOFT_FAIL (optional, '1'): a refused re-run is a warning, not an error. Set for
//           the CI-completion trigger, where the schedule is the backstop that still fails loudly.
// Exit 0 on success, including when there is nothing to heal; non-zero only on a real error.

import { execFileSync } from 'node:child_process'

/** The CI workflow, by file name. Only its runs gate merges. */
export const WORKFLOW = 'ci.yml'
/** Attempts a run may reach before this stops re-running it: the original plus two re-runs. */
export const MAX_ATTEMPTS = 3

/** The PRs to check: non-draft ones, narrowed to the PR at `headSha` when one is given. */
export function selectPrs(prs, headSha) {
  return prs.filter((pr) => !pr.isDraft && (!headSha || pr.headRefOid === headSha))
}

/**
 * What to do about one PR, given the CI runs (REST `workflow_run` objects) on its head
 * commit for the pull_request event. Pure, so every branch is unit-tested.
 * @returns {{ action: 'rerun', run: object } | { action: 'none', reason: string } | { action: 'give-up', run: object }}
 */
export function decide(runs) {
  if (!runs || runs.length === 0) return { action: 'none', reason: 'no CI runs on the head commit' }
  if (runs.some((r) => r.status !== 'completed')) return { action: 'none', reason: 'a CI run is still going' }
  // Newest suite is what GitHub reads. Suite ids and run ids both rise monotonically; the
  // suite id is the one GitHub actually compares, so prefer it.
  const key = (r) => r.check_suite_id ?? r.id
  const newest = runs.reduce((a, b) => (key(b) > key(a) ? b : a))
  if (newest.conclusion !== 'cancelled') return { action: 'none', reason: `newest CI run ended ${newest.conclusion}` }
  if ((newest.run_attempt ?? 1) >= MAX_ATTEMPTS) return { action: 'give-up', run: newest }
  return { action: 'rerun', run: newest }
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8' })
}

function main() {
  const repo = process.env.GH_REPO
  if (!repo) {
    console.error('::error::GH_REPO must be set.')
    process.exit(2)
  }

  const headSha = process.env.HEAD_SHA || ''
  const softFail = process.env.SOFT_FAIL === '1'
  // Every open PR, not just Dependabot's: a human PR opened with a label races the same way.
  // Drafts cannot be queued, so their CI minutes are not worth spending here.
  const prs = selectPrs(
    JSON.parse(gh(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '200', '--json', 'number,headRefOid,isDraft'])),
    headSha
  )

  let healed = 0
  for (const pr of prs) {
    const runs = JSON.parse(
      gh([
        'api',
        `repos/${repo}/actions/workflows/${WORKFLOW}/runs?head_sha=${pr.headRefOid}&event=pull_request&per_page=100`,
        '--jq',
        '.workflow_runs'
      ])
    )
    const verdict = decide(runs)
    if (verdict.action === 'none') continue
    if (verdict.action === 'give-up') {
      console.log(
        `::warning::PR #${pr.number}: newest CI run ${verdict.run.id} is cancelled after ${verdict.run.run_attempt} attempts; not re-running it again. Re-run it by hand or push a new commit.`
      )
      continue
    }
    try {
      gh(['api', '-X', 'POST', `repos/${repo}/actions/runs/${verdict.run.id}/rerun`])
    } catch (err) {
      if (!softFail) throw err
      console.log(
        `::warning::PR #${pr.number}: could not re-run CI run ${verdict.run.id} (${String(err.message).split('\n')[0]}). The scheduled run will retry it.`
      )
      continue
    }
    console.log(`PR #${pr.number}: newest CI run ${verdict.run.id} was cancelled; re-running it.`)
    healed++
  }
  console.log(`${prs.length} open non-draft PR(s) checked${headSha ? ` at ${headSha}` : ''}, ${healed} CI run(s) re-run.`)
}

// Only run when invoked as a script, so the tests can import the pure helpers.
if (process.argv[1] && process.argv[1].endsWith('heal-cancelled-ci.mjs')) main()
