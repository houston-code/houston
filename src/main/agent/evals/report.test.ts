import { describe, expect, it } from 'vitest'
import { failureCauses, summarize, type TaskReport } from './report'
import type { EvalResult } from './types'

const result = (over: Partial<EvalResult> = {}): EvalResult => ({
  taskId: 't',
  passed: false,
  exitCode: 1,
  verifyOutput: 'AssertionError: expected 1 to equal 2',
  toolsUsed: [],
  durationMs: 10,
  costUsd: 0,
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
