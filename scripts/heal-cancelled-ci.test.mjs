import { describe, it, expect } from 'vitest'
import { decide, MAX_ATTEMPTS, WORKFLOW } from './heal-cancelled-ci.mjs'

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

  it('targets the CI workflow, the only one whose checks gate merges', () => {
    expect(WORKFLOW).toBe('ci.yml')
  })
})
