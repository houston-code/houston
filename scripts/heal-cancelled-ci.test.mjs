import { describe, it, expect } from 'vitest'
import { decide, selectPrs, MAX_ATTEMPTS, REQUIRED_JOBS, WORKFLOW } from './heal-cancelled-ci.mjs'

// Shaped like the REST workflow_run objects `gh api .../runs?head_sha=` returns.
const run = (id, suite, conclusion, extra = {}) => ({
  id,
  check_suite_id: suite,
  status: 'completed',
  conclusion,
  run_attempt: 1,
  ...extra
})

describe('decide', () => {
  it('re-runs the newest run when it was cancelled, even though an older sibling passed', () => {
    // PR #577 exactly: three runs started in the same second; the green one is not the
    // newest suite, and the newest is cancelled with no jobs, so all required checks read
    // "expected".
    const runs = [run(41240661918, 111785352812, 'cancelled'), run(41240662602, 111785354648, 'success'), run(41240662660, 111785354792, 'cancelled')]
    expect(decide(runs)).toEqual({ action: 'rerun', run: runs[2] })
  })

  it('leaves a PR alone when the newest run reached a result', () => {
    // PRs #559/#575/#580: same duplicate runs, but the survivor happened to be the newest.
    const runs = [run(1, 10, 'cancelled'), run(2, 11, 'cancelled'), run(3, 12, 'success')]
    expect(decide(runs)).toEqual({ action: 'none', reason: 'newest CI run ended success' })
    expect(decide([run(1, 10, 'failure')]).action).toBe('none')
  })

  it('compares check suite ids, not array order or run ids', () => {
    // The API lists newest first; the suite id is what GitHub ranks by.
    const newest = run(5, 99, 'cancelled')
    expect(decide([newest, run(9, 50, 'success')])).toEqual({ action: 'rerun', run: newest })
  })

  it('falls back to the run id when a run carries no suite id', () => {
    const newest = { id: 7, status: 'completed', conclusion: 'cancelled' }
    expect(decide([{ id: 3, status: 'completed', conclusion: 'success' }, newest])).toEqual({ action: 'rerun', run: newest })
  })

  it('waits while any run on the commit is still going', () => {
    // An in-progress run may yet be the one that counts, and re-running a sibling would
    // cancel it through the ci-<PR> concurrency group.
    const runs = [run(1, 10, 'cancelled'), run(2, 11, null, { status: 'in_progress' })]
    expect(decide(runs)).toEqual({ action: 'none', reason: 'a CI run is still going' })
    expect(decide([run(1, 10, 'cancelled'), run(2, 11, null, { status: 'queued' })]).action).toBe('none')
  })

  it('does nothing when the commit has no CI runs', () => {
    expect(decide([]).action).toBe('none')
    expect(decide(undefined).action).toBe('none')
  })

  it('re-runs a run that is cancelled with no passing sibling', () => {
    const runs = [run(1, 10, 'cancelled'), run(2, 11, 'cancelled')]
    expect(decide(runs)).toEqual({ action: 'rerun', run: runs[1] })
  })

  it('gives up after MAX_ATTEMPTS so a deliberate or repeated cancel cannot loop', () => {
    expect(MAX_ATTEMPTS).toBe(3)
    expect(decide([run(1, 10, 'cancelled', { run_attempt: 2 })]).action).toBe('rerun')
    const stuck = run(1, 10, 'cancelled', { run_attempt: MAX_ATTEMPTS })
    expect(decide([stuck])).toEqual({ action: 'give-up', run: stuck })
  })

  it('leaves a cancelled newest run alone when it passed every required check', () => {
    // A package leg cancelled for want of a runner, passed by package-retry: the run ends
    // cancelled, yet its suite holds green results for every required check.
    const runs = [run(1, 10, 'success'), run(2, 11, 'cancelled')]
    const passed = ['plan', 'test', 'linux-sandbox', 'package-retry (mac-arm64)', 'build', 'revert-guard']
    expect(REQUIRED_JOBS).toEqual(['test', 'linux-sandbox', 'build', 'revert-guard'])
    expect(decide(runs, passed)).toEqual({ action: 'none', reason: 'newest CI run was cancelled but passed every required check' })
    expect(decide([run(2, 11, 'cancelled', { run_attempt: MAX_ATTEMPTS })], passed).action).toBe('none')
    // Missing any required check (or no jobs at all, the empty suite this exists for): re-run.
    expect(decide(runs, passed.filter((n) => n !== 'build'))).toEqual({ action: 'rerun', run: runs[1] })
    expect(decide(runs, [])).toEqual({ action: 'rerun', run: runs[1] })
  })

  it('targets the CI workflow, the only one whose checks gate merges', () => {
    expect(WORKFLOW).toBe('ci.yml')
  })
})

describe('selectPrs', () => {
  const prs = [
    { number: 1, headRefOid: 'aaa', isDraft: false },
    { number: 2, headRefOid: 'bbb', isDraft: true },
    { number: 3, headRefOid: 'ccc', isDraft: false }
  ]

  it('checks every non-draft PR on the scheduled sweep', () => {
    expect(selectPrs(prs, '').map((p) => p.number)).toEqual([1, 3])
    expect(selectPrs(prs, undefined).map((p) => p.number)).toEqual([1, 3])
  })

  it('checks only the PR whose head finished CI when triggered by a CI run', () => {
    expect(selectPrs(prs, 'ccc').map((p) => p.number)).toEqual([3])
  })

  it('checks nothing when that commit is no longer any PR head, or is a draft', () => {
    // A superseded commit: its CI result can no longer gate anything.
    expect(selectPrs(prs, 'zzz')).toEqual([])
    expect(selectPrs(prs, 'bbb')).toEqual([])
  })
})
