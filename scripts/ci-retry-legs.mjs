#!/usr/bin/env node
// Decide which `package` legs of a CI run to run a second time because GitHub never gave
// them a runner. ci.yml's `package-retry-plan` job runs this after `package` ends without
// succeeding, and feeds its output to `package-retry` and the required `build` gate.
//
// THE FAILURE THIS CLOSES. When the hosted macOS pool is out of capacity, a queued job waits
// about 15 minutes and GitHub then cancels it ("The job was not acquired by Runner of type
// hosted even after multiple attempts"). The job ran nothing: no runner, no steps. But it
// counted as a package leg that did not succeed, so `build` failed, a good PR was ejected
// from the merge queue, and the nightly run on main went red and filed an alert. Both
// happened within twenty minutes of each other on 2026-11-12.
//
// THE FIX. A leg that never started says nothing about the commit, so it gets one more wait
// for a runner, inside the same run (a re-run from outside comes too late for a queue
// candidate: the queue ejects the PR the moment `build` fails). `build` then accepts the
// retried legs in place of the originals.
//
// The retry is deliberately narrow. If any leg did start and then failed or was cancelled,
// nothing is retried: that run is red on its merits, and a second pass would only hold
// runners. A leg is retried once; if the retry gets no runner either, `build` fails as before.
//
// Usage (in CI): GH_TOKEN=<actions: read> GH_REPO=<owner/name> RUN_ID=<id> RUN_ATTEMPT=<n> \
//   node scripts/ci-retry-legs.mjs >> "$GITHUB_OUTPUT"

import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { LEGS } from './ci-plan.mjs'

/** The `package` matrix jobs, by name. Not `package-retry (...)`, and not `build`. */
const PACKAGE_JOB = /^package \(([^)]+)\)$/

/** True for a job GitHub cancelled before any runner picked it up: it ran no step at all. */
export function neverStarted(job) {
  return job.conclusion === 'cancelled' && (job.steps ?? []).length === 0 && !job.runner_id && !job.runner_name
}

/**
 * @param {object[]} jobs The run attempt's jobs (REST `job` objects).
 * @returns {{ legs: string[], reason: string }} The legs to run again, and why (or why none).
 */
export function decide(jobs) {
  const packageJobs = (jobs ?? []).flatMap((job) => {
    const match = PACKAGE_JOB.exec(job.name ?? '')
    return match ? [{ job, target: match[1] }] : []
  })
  if (packageJobs.length === 0) return { legs: [], reason: 'the run has no package legs' }
  const unfinished = packageJobs.filter(({ job }) => job.status !== 'completed')
  if (unfinished.length > 0) {
    return { legs: [], reason: `still running: ${unfinished.map((p) => p.target).join(', ')}` }
  }
  const notGreen = packageJobs.filter(({ job }) => job.conclusion !== 'success')
  if (notGreen.length === 0) return { legs: [], reason: 'every package leg succeeded' }
  const real = notGreen.filter(({ job }) => !neverStarted(job))
  if (real.length > 0) {
    return {
      legs: [],
      reason: `a leg that did start did not succeed: ${real.map((p) => `${p.target} (${p.job.conclusion})`).join(', ')}`
    }
  }
  const unknown = notGreen.filter(({ target }) => !Object.hasOwn(LEGS, target))
  if (unknown.length > 0) {
    return { legs: [], reason: `not a known leg: ${unknown.map((p) => p.target).join(', ')}` }
  }
  const legs = [...new Set(notGreen.map((p) => p.target))]
  return { legs, reason: `never got a runner: ${legs.join(', ')}` }
}

/** The decision as GITHUB_OUTPUT lines. */
export function outputs({ legs }) {
  return [`retry=${legs.length > 0}`, `matrix=${JSON.stringify({ include: legs.map((l) => LEGS[l]) })}`].join('\n')
}

function main() {
  const { GH_REPO: repo, RUN_ID: runId, RUN_ATTEMPT: attempt } = process.env
  if (!repo || !/^\d+$/.test(runId ?? '') || !/^\d+$/.test(attempt ?? '')) {
    console.error('::error::GH_REPO, RUN_ID and RUN_ATTEMPT must be set.')
    process.exit(2)
  }
  // One JSON object per line, across every page.
  const jobs = execFileSync(
    'gh',
    ['api', '--paginate', `repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`, '--jq', '.jobs[]'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const verdict = decide(jobs)
  // stdout is GITHUB_OUTPUT, so the explanation goes to stderr (the job log).
  console.error(verdict.legs.length > 0 ? `Retrying package legs that ${verdict.reason}.` : `No retry: ${verdict.reason}.`)
  console.log(outputs(verdict))
}

// Only run when invoked as a script, so the tests can import the pure helpers.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
