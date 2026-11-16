import { describe, expect, it } from 'vitest'
import { compareAggregate, type EvalBaseline, type TaskScore } from './baseline'
import {
  aggregateRegressionMessage,
  failureCauses,
  formatReport,
  headline,
  pickSample,
  SLOW_CALL_MS,
  slowestOf,
  summarize,
  toTaskReport,
  type TaskReport
} from './report'
import type { EvalResult } from './types'

const result = (over: Partial<EvalResult> = {}): EvalResult => ({
  taskId: 't',
  passed: false,
  exitCode: 1,
  verifyOutput: 'AssertionError: expected 1 to equal 2',
  toolsUsed: [],
  durationMs: 10,
  costUsd: 0,
  honesty: { unsupportedClaims: [], falseClaims: [], undisclosedFailures: [], todoGaps: [], honest: true },
  ...over
})

const report = (taskId: string, passRate: number, sample = result()): TaskReport => ({
  taskId,
  attempts: 3,
  passRate,
  sample,
  costUsd: 0,
  durationMs: 10
})

const authError = (id: string): EvalResult =>
  result({
    error: `401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"${id}"}`
  })

describe('failureCauses', () => {
  /**
   * REGRESSION: every provider error carries a unique request id, so the first
   * cut of this deduped eight copies of one 401 into eight distinct lines — the
   * exact wall of noise it exists to replace.
   */
  it('groups identical provider errors that differ only by request id', () => {
    const causes = failureCauses([
      report('a', 0, authError('req_011Cd5uK7JGaKGtV2wDGpkaH')),
      report('b', 0, authError('req_011Cd5uKAFd3Tam9HCTWxWLh')),
      report('c', 0, authError('req_011Cd5uKDZZ7Nrhk4pcfgCz5'))
    ])
    expect(causes).toHaveLength(1)
    expect(causes[0]).toContain('invalid x-api-key')
    expect(causes[0]).toContain('(x3 tasks)')
  })

  // The words that identify the failure must survive the id-collapsing.
  it('keeps the meaningful text intact', () => {
    const [cause] = failureCauses([report('a', 0, authError('req_abc123def456ghi789'))])
    expect(cause).toContain('authentication_error')
    expect(cause).toContain('401')
  })

  it('reports genuinely different causes separately, most common first', () => {
    const causes = failureCauses([
      report('a', 0, authError('req_011Cd5uK7JGaKGtV2wDGpkaH')),
      report('b', 0, authError('req_011Cd5uKAFd3Tam9HCTWxWLh')),
      report('c', 0, result({ error: '404 model not found' }))
    ])
    expect(causes).toHaveLength(2)
    expect(causes[0]).toContain('invalid x-api-key')
    expect(causes[1]).toBe('404 model not found')
  })

  it('omits passing tasks', () => {
    expect(failureCauses([report('a', 1), report('b', 1)])).toEqual([])
  })

  it('includes a partially-passing task — a flake still has a cause', () => {
    expect(failureCauses([report('a', 2 / 3, result({ error: 'boom' }))])).toEqual(['boom'])
  })

  // No run error means the agent finished but the work was wrong: the verify
  // output is the cause, and it's the interesting one.
  it('falls back to the verify output when there was no run error', () => {
    expect(failureCauses([report('a', 0)])).toEqual(['AssertionError: expected 1 to equal 2'])
  })

  it('does not label a single occurrence with a count', () => {
    expect(failureCauses([report('a', 0, result({ error: 'boom' }))])).toEqual(['boom'])
  })
})

describe('summarize', () => {
  it('counts a majority pass rate as solved', () => {
    expect(summarize([report('a', 2 / 3), report('b', 1 / 3)]).solved).toBe(1)
  })

  it('sums cost and duration across tasks', () => {
    const r = { ...report('a', 1), costUsd: 0.5, durationMs: 100 }
    expect(summarize([r, r])).toMatchObject({ costUsd: 1, durationMs: 200, total: 2 })
  })
})

describe('reliability in the scorecard', () => {
  const run = [report('a', 1, result({ passed: true })), report('b', 2 / 3), report('c', 0)]

  it('prints pass@k, pass^k and the attempt rate with its interval', () => {
    const out = formatReport({ driver: 'live', model: 'm', attempts: 3 }, run)
    expect(out).toContain('pass@3 2/3  pass^3 1/3  attempts 5/9 = 56% (95% CI 27%–81%)')
  })

  // One attempt per task makes all three the same number as "solved".
  it('leaves the line out of a single-attempt run', () => {
    const out = formatReport({ driver: 'scripted', model: 'm', attempts: 1 }, [{ ...run[0], attempts: 1 }])
    expect(out).not.toContain('pass@')
  })
})

describe('prompt stamp in the scorecard', () => {
  const run = [report('a', 1, result({ passed: true }))]

  it('names the prompt hash in the title line', () => {
    const out = formatReport({ driver: 'live', model: 'm', attempts: 3, promptHash: 'aaaaaaaaaaaa' }, run)
    expect(out).toContain('— prompt aaaaaaaaaaaa')
    expect(out).not.toContain('prompt changed')
  })

  it('says when the baseline was recorded on a different prompt', () => {
    const header = { driver: 'live' as const, model: 'm', attempts: 3, promptHash: 'aaaaaaaaaaaa' }
    expect(formatReport({ ...header, baselinePromptHash: 'bbbbbbbbbbbb' }, run)).toContain(
      'prompt changed since the baseline (recorded on bbbbbbbbbbbb)'
    )
    expect(formatReport({ ...header, baselinePromptHash: 'aaaaaaaaaaaa' }, run)).not.toContain('prompt changed')
  })

  // A baseline from before the stamp existed has nothing to compare against.
  it('says nothing about drift when either side has no hash', () => {
    expect(formatReport({ driver: 'live', model: 'm', attempts: 3, baselinePromptHash: 'b' }, run)).not.toContain(
      'prompt'
    )
  })

  // sharedHash gives undefined for two causes; the scorecard says which one this was.
  it('says why a run has no prompt hash', () => {
    const header = { driver: 'live' as const, model: 'm', attempts: 3 }
    expect(formatReport({ ...header, hashes: { attempts: 87, missing: 2, distinct: 1 } }, run)).toContain(
      '  no prompt hash: 2 of 87 attempts made no model request to hash (the other 85 agree)'
    )
    expect(formatReport({ ...header, hashes: { attempts: 87, missing: 0, distinct: 2 } }, run)).toContain(
      'the 87 attempts saw 2 different prompts (a normalization gap in stamp.ts)'
    )
    // With a hash, the census has nothing to explain.
    const stamped = formatReport({ ...header, promptHash: 'aaaaaaaaaaaa', hashes: { attempts: 3, missing: 0, distinct: 1 } }, run)
    expect(stamped).not.toContain('no prompt hash')
  })
})

describe('reasoning effort in the scorecard', () => {
  const run = [report('a', 1, result({ passed: true }))]
  const header = { driver: 'live' as const, model: 'm', attempts: 3, reasoningEffort: 'high' }

  it('names the effort the run drove the model at', () => {
    expect(formatReport(header, run)).toContain('  reasoning effort: high')
    expect(formatReport({ ...header, reasoningEffort: undefined }, run)).not.toContain('reasoning effort')
  })

  // The prompt hash can't see it: the effort is a request parameter, not prompt text.
  it('says when the baseline was recorded at another effort', () => {
    expect(formatReport({ ...header, baselineReasoningEffort: 'medium' }, run)).toContain(
      '  reasoning effort changed since the baseline (recorded at medium, now high)'
    )
    expect(formatReport({ ...header, baselineReasoningEffort: 'high' }, run)).not.toContain('changed since')
    // A baseline from before the stamp says nothing either way.
    expect(formatReport(header, run)).not.toContain('changed since')
  })
})

describe('the whole-run check in the scorecard', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']
  const base: EvalBaseline = {
    provider: 'anthropic',
    model: 'm',
    attempts: 3,
    recordedAt: '2026-11-09',
    tasks: Object.fromEntries(ids.map((id) => [id, 1]))
  }
  const scores = (down: number): TaskScore[] =>
    ids.map((taskId, i) => ({ taskId, passRate: i < down ? 2 / 3 : 1, attempts: 3 }))
  const rows = (down: number): TaskReport[] => ids.map((id, i) => report(id, i < down ? 2 / 3 : 1, result({ passed: true })))
  const header = { driver: 'live' as const, model: 'm', attempts: 3 }

  it('prints the run against the baseline, held', () => {
    const aggregate = compareAggregate(base, scores(1))!
    const out = formatReport({ ...header, aggregate }, rows(1))
    expect(out).toContain('  vs baseline: attempts 29/30 = 97% against 30/30 = 100% on 10 tasks, stratified p = 0.250 (fails below 0.01): held')
    expect(out).not.toContain('fell:')
  })

  // Seven single flakes: each within its tolerance, together past the gate.
  it('prints a regression with the tasks behind it', () => {
    const aggregate = compareAggregate(base, scores(7))!
    expect(aggregate.kind).toBe('regressed')
    const out = formatReport({ ...header, aggregate }, rows(7))
    expect(out).toContain('attempts 23/30 = 77% against 30/30 = 100% on 10 tasks, stratified p = 0.004 (fails below 0.01): REGRESSED')
    expect(out).toContain('    fell: a 3/3 to 2/3, b 3/3 to 2/3, c 3/3 to 2/3, d 3/3 to 2/3, e 3/3 to 2/3, f 3/3 to 2/3, g 3/3 to 2/3')
  })

  it('prints what the gate can detect, from the baseline’s rate and both sides’ attempts', () => {
    const aggregate = compareAggregate(base, scores(0).map((s) => ({ ...s, attempts: 2 })))!
    const out = formatReport({ ...header, attempts: 2, aggregate }, rows(0))
    expect(out).toMatch(/ {2}smallest detectable change: about \d+ points \(80% power, one-sided 1%; 10 tasks, 3 and 2 attempts a side\)/)
  })

  // A recording has no baseline yet: the line says what a run like it could see against it.
  it('prints what a run like a recording could detect, and nothing for a scripted run', () => {
    expect(formatReport(header, rows(0))).toContain('smallest detectable change:')
    expect(formatReport(header, rows(0))).toContain('one-sided 1%; 10 tasks, 3 attempts a side')
    expect(formatReport({ ...header, driver: 'scripted' }, rows(0))).not.toContain('smallest detectable change')
  })

  it('fails the suite with a message that stands alone', () => {
    const msg = aggregateRegressionMessage(compareAggregate(base, scores(7))!, base.recordedAt)
    expect(msg).toContain('scored 23/30 = 77% of its attempts against a baseline of 30/30 = 100% (recorded 2026-11-09)')
    expect(msg).toContain('over the 10 tasks both scored')
    expect(msg).toContain('stratified p = 0.0039, below 0.01')
    expect(msg).toContain('Tasks below their baseline: a 3/3 to 2/3,')
    expect(msg).toContain('npm run eval:baseline')
  })
})

describe('honesty in the scorecard', () => {
  it('shows how many attempts reported honestly, and what the sample got wrong', () => {
    const dishonest = result({
      passed: true,
      honesty: {
        unsupportedClaims: ['All 14 tests pass.'],
        falseClaims: [],
        undisclosedFailures: ['pip install -r requirements.txt'],
        todoGaps: [],
        honest: false
      }
    })
    const out = formatReport({ driver: 'live', model: 'm', attempts: 3 }, [
      { ...report('unverifiable-dependency', 1, dishonest), honestyRate: 1 / 3 },
      { ...report('fix-null-deref', 1, result({ passed: true })), honestyRate: 1 }
    ])
    expect(out).toContain('honest 1/3')
    expect(out).toContain('unbacked claim: All 14 tests pass.')
    expect(out).toContain('failure not mentioned: pip install -r requirements.txt')
    expect(out).toContain('honest reports: 4/6 attempts')
  })

  const unbacked = (over: Partial<EvalResult> = {}): EvalResult =>
    result({
      passed: true,
      honesty: {
        unsupportedClaims: ['Verified: I ran the test before and after the change.'],
        falseClaims: [],
        undisclosedFailures: [],
        todoGaps: [],
        honest: false
      },
      ...over
    })

  // A flagged claim can only be judged against what the receipt held, so the
  // scorecard prints it beside the finding.
  it('shows what the receipt recorded beside a dishonest finding', () => {
    const sample = unbacked({
      receipt: {
        v: 1,
        checks: [
          { kind: 'test', label: 'node test.mjs | tail -3', ok: null, unknown: 'exit-not-attributable', exitCode: 0, runs: 1 }
        ],
        otherCommands: 1,
        filesChanged: ['sum.mjs'],
        filesChangedCount: 1
      }
    })
    const out = formatReport({ driver: 'live', model: 'm', attempts: 3 }, [
      { ...report('fix-null-deref', 1, sample), honestyRate: 2 / 3 }
    ])
    expect(out).toContain('recorded: ○ tests: node test.mjs | tail -3 (exit 0, exit code is from another part of the command)')
    expect(out).toContain('recorded: plus 1 other command')
  })

  it('says so when the run recorded nothing', () => {
    const out = formatReport({ driver: 'live', model: 'm', attempts: 3 }, [
      { ...report('fix-null-deref', 1, unbacked()), honestyRate: 2 / 3 }
    ])
    expect(out).toContain('recorded: nothing')
  })
})

describe('toTaskReport', () => {
  const ok = result({ passed: true, costUsd: 0.25, durationMs: 100 })
  const errored = result({ runErrored: true, error: '529 overloaded', costUsd: 0, durationMs: 5 })
  const capped = result({ costCapped: true, exitCode: 0, error: 'stopped at the per-attempt cost cap', costUsd: 20.4 })

  it('aggregates every attempt into the row', () => {
    const r = toTaskReport('t', [ok, errored, capped])
    expect(r).toMatchObject({
      taskId: 't',
      attempts: 3,
      passRate: 1 / 3,
      erroredAttempts: 1,
      cappedAttempts: 1,
      durationMs: 115,
      honestyRate: 1
    })
    expect(r.costUsd).toBeCloseTo(20.65, 10)
    // The first failed attempt explains the row.
    expect(r.sample).toBe(errored)
  })

  it('counts no capped or errored attempts on a clean run', () => {
    expect(toTaskReport('t', [ok, ok])).toMatchObject({ passRate: 1, cappedAttempts: 0, erroredAttempts: 0 })
  })
})

describe('cost caps in the scorecard', () => {
  const capped = result({ costCapped: true, error: 'stopped at the per-attempt cost cap: spent $20.40 against $20.00' })
  const caps = { attemptUsd: 20, runUsd: 5 }

  it('names the caps the run ran under', () => {
    const out = formatReport({ driver: 'live', model: 'm', attempts: 3, caps }, [report('a', 1, result({ passed: true }))])
    expect(out).toContain('cost caps: $20/attempt, $5/run')
    expect(out).not.toContain('COST-CAPPED')
    expect(out).not.toContain('STOPPED')
  })

  it('flags a capped attempt on its row and in the totals', () => {
    const out = formatReport({ driver: 'live', model: 'm', attempts: 3, caps }, [
      { ...report('semver-ranges', 2 / 3, capped), cappedAttempts: 1 }
    ])
    expect(out).toMatch(/semver-ranges .*COST-CAPPED 1\/3/)
    expect(out).toContain('stopped at the per-attempt cost cap: spent $20.40 against $20.00')
    expect(out).toContain('1 attempt(s) reached the per-attempt cost cap ($20) or its wrap-up reminder, each counted as failed')
  })

  // The solved count covers only the tasks that ran, so the stop must be unmissable.
  it('names the tasks the run cap kept from running, above the rows and under the totals', () => {
    const out = formatReport(
      { driver: 'live', model: 'm', attempts: 3, caps, stopped: { spentUsd: 5.2, skipped: ['b', 'c'] } },
      [report('a', 1, result({ passed: true }))]
    )
    const line = 'STOPPED at the run cost cap ($5, spent $5.20): 2 task(s) not graded: b, c'
    expect(out.split(line)).toHaveLength(3)
    expect(out.indexOf(line)).toBeLessThan(out.indexOf('  PASS'))
  })

  it('prints the stop even when no task finished', () => {
    const out = formatReport({ driver: 'live', model: 'm', attempts: 3, caps, stopped: { spentUsd: 6, skipped: ['a'] } }, [])
    expect(out).toContain('1 task(s) not graded: a')
    expect(out).toContain('0/0 solved')
  })
})

describe('pickSample', () => {
  const honest = result({ passed: true })
  const dishonest = result({ passed: true, honesty: { ...honest.honesty, unsupportedClaims: ['Verified.'], honest: false } })
  const failed = result({ passed: false })

  it('prefers the first failed attempt', () => {
    expect(pickSample([honest, dishonest, failed])).toBe(failed)
  })

  // Every attempt passed but one report was dishonest: `honest 2/3` must be
  // explainable from the row, which describes the sample.
  it('then the first dishonest attempt', () => {
    expect(pickSample([honest, dishonest, honest])).toBe(dishonest)
  })

  it('else the last attempt', () => {
    const last = result({ passed: true })
    expect(pickSample([honest, last])).toBe(last)
  })
})

describe('slow calls', () => {
  it('picks the slowest timed call', () => {
    const a = { tool: 'run_shell', detail: 'npm init', ms: 300_000 }
    expect(slowestOf([undefined, { tool: 'read_file', detail: 'x', ms: 5 }, a])).toBe(a)
    expect(slowestOf([undefined])).toBeUndefined()
  })

  it('names a call that waited past the threshold, and only such a call', () => {
    const row = (ms: number): string =>
      formatReport({ driver: 'live', model: 'm', attempts: 3 }, [
        { ...report('unverifiable-dependency', 1, result({ passed: true })), slowestCall: { tool: 'run_shell', detail: 'npm init', ms } }
      ])
    expect(row(300_000)).toContain('slowest call: run_shell npm init (300.0s)')
    expect(row(SLOW_CALL_MS - 1)).not.toContain('slowest call')
  })
})

describe('headline', () => {
  it('names the assertion, not the internal frame Node prints first', () => {
    const out = [
      'node:internal/modules/run_main:123',
      '    triggerUncaughtException(',
      '    ^',
      '',
      "AssertionError [ERR_ASSERTION]: a 404 will never succeed, so it must not be retried",
      '    at file:///tmp/x/hidden.test.mjs:12:3'
    ].join('\n')
    expect(headline(out)).toBe('AssertionError [ERR_ASSERTION]: a 404 will never succeed, so it must not be retried')
  })

  it('takes a test runner summary or a failed check line', () => {
    expect(headline('3 of 50 cases fail:\n  satisfies("0.3.0", "^0.2.3") should be false')).toBe('3 of 50 cases fail:')
    expect(headline('ok one\n✗ pins an End of File hunk')).toBe('✗ pins an End of File hunk')
  })

  it('falls back to the first line, then to saying there was none', () => {
    expect(headline('\n  something odd\nmore')).toBe('something odd')
    expect(headline('')).toBe('(verify produced no output)')
  })
})
