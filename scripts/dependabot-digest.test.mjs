import { describe, it, expect } from 'vitest'
import { checkFails, isFailing, failingPrs, digestBody, plan, TITLE, LABEL } from './dependabot-digest.mjs'

// The gh calls live in main(); everything that decides *what* the digest says is pure, so it
// is driven here with synthetic statusCheckRollup payloads shaped like `gh pr list --json`.
const pr = (number, checks, title = `chore(deps): bump thing ${number}`) => ({
  number,
  title,
  url: `https://github.com/o/r/pull/${number}`,
  statusCheckRollup: checks
})
const run = (conclusion) => ({ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion })
const ctx = (state) => ({ __typename: 'StatusContext', context: 'legacy', state })

describe('checkFails', () => {
  it('counts a conclusive bad end as a failure', () => {
    for (const c of ['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED']) {
      expect(checkFails(run(c)), c).toBe(true)
    }
  })

  it('does NOT count a cancellation — concurrency cancels runs routinely', () => {
    // 16 of the 97 measured Dependabot runs were cancelled rather than broken. Reporting
    // those would bury the real failures, which is how a digest gets ignored.
    expect(checkFails(run('CANCELLED'))).toBe(false)
  })

  it('does not count success, or a check that has not finished', () => {
    expect(checkFails(run('SUCCESS'))).toBe(false)
    expect(checkFails(run('NEUTRAL'))).toBe(false)
    expect(checkFails(run('SKIPPED'))).toBe(false)
    // In-progress: conclusion is empty and status is not COMPLETED. Not failed — unfinished.
    expect(checkFails({ __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '' })).toBe(false)
  })

  it('reads `state` for a legacy StatusContext, which carries no conclusion', () => {
    expect(checkFails(ctx('FAILURE'))).toBe(true)
    expect(checkFails(ctx('ERROR'))).toBe(true)
    expect(checkFails(ctx('SUCCESS'))).toBe(false)
    expect(checkFails(ctx('PENDING'))).toBe(false)
  })

  it('treats an unrecognized entry as not-failing rather than throwing', () => {
    expect(checkFails({})).toBe(false)
  })
})

describe('isFailing', () => {
  it('is true when any single check failed, even among passing ones', () => {
    expect(isFailing(pr(1, [run('SUCCESS'), run('FAILURE'), run('SUCCESS')]))).toBe(true)
  })

  it('is false when every check passed', () => {
    expect(isFailing(pr(1, [run('SUCCESS'), run('SKIPPED')]))).toBe(false)
  })

  it('is false for a PR with no checks at all, and tolerates a missing rollup', () => {
    expect(isFailing(pr(1, []))).toBe(false)
    expect(isFailing({ number: 1 })).toBe(false)
  })
})

describe('failingPrs', () => {
  it('keeps only the red ones, in stable PR-number order', () => {
    const prs = [
      pr(30, [run('FAILURE')]),
      pr(10, [run('SUCCESS')]),
      pr(20, [run('TIMED_OUT')]),
      pr(5, [run('CANCELLED')])
    ]
    expect(failingPrs(prs).map((p) => p.number)).toEqual([20, 30])
  })

  it('returns nothing when the whole batch is green', () => {
    expect(failingPrs([pr(1, [run('SUCCESS')]), pr(2, [])])).toEqual([])
  })
})

describe('digestBody', () => {
  it('lists every failing PR as a link, with the run that checked', () => {
    const body = digestBody([pr(7, [run('FAILURE')], 'bump electron')], 'https://run/1')
    expect(body).toContain('**1 Dependabot PR is failing CI.**')
    expect(body).toContain('- [#7](https://github.com/o/r/pull/7) — bump electron')
    expect(body).toContain('Checked by https://run/1')
  })

  it('agrees in number for a batch', () => {
    const body = digestBody([pr(1, []), pr(2, [])], 'https://run/1')
    expect(body).toContain('**2 Dependabot PRs are failing CI.**')
  })

  it('renders at column 0 — leading indentation would make GitHub show it as a code block', () => {
    const body = digestBody([pr(1, [])], 'https://run/1')
    for (const line of body.split('\n')) expect(line).not.toMatch(/^\s+\S/)
  })
})

describe('plan', () => {
  const issue = { number: 42, title: TITLE }

  it('files a digest when PRs are red and none is open', () => {
    expect(plan([pr(1, [])], undefined)).toEqual({ action: 'create' })
  })

  it('updates the open digest rather than filing a second one', () => {
    expect(plan([pr(1, [])], issue)).toEqual({ action: 'comment' })
  })

  it('closes the digest once every Dependabot PR is green', () => {
    expect(plan([], issue)).toEqual({ action: 'close' })
  })

  it('does nothing when all green with no digest open — silence when there is no news', () => {
    expect(plan([], undefined)).toEqual({ action: 'none' })
  })
})

describe('identity', () => {
  it('uses its own label, so an alert-on-failure issue can never be closed by this', () => {
    expect(LABEL).toBe('dependabot-digest')
    expect(LABEL).not.toBe('scheduled-failure')
  })
})
