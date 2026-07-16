import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TOLERANCE,
  baselineFileName,
  compareToBaseline,
  isEvalBaseline,
  recordBaseline,
  regressions,
  type EvalBaseline,
  type TaskScore
} from './baseline'

const baseline = (tasks: Record<string, number>): EvalBaseline => ({
  provider: 'anthropic',
  model: 'claude-opus-4-8',
  attempts: 3,
  recordedAt: '2026-07-16',
  tasks
})

const score = (taskId: string, passRate: number): TaskScore => ({ taskId, passRate, attempts: 3 })

describe('compareToBaseline', () => {
  it('holds a task that matches its baseline', () => {
    const v = compareToBaseline(baseline({ a: 1 }), [score('a', 1)])
    expect(v).toEqual([{ kind: 'held', taskId: 'a', baseline: 1, observed: 1 }])
  })

  it('regresses a task that drops past the tolerance', () => {
    const v = compareToBaseline(baseline({ a: 1 }), [score('a', 1 / 3)])
    expect(v[0].kind).toBe('regressed')
    expect(regressions(v)).toHaveLength(1)
  })

  // The whole point of the tolerance: a live model that flakes one attempt out of
  // three must NOT red the nightly, or the job gets ignored and catches nothing.
  it('absorbs a single flaked attempt at the default tolerance', () => {
    const v = compareToBaseline(baseline({ a: 1 }), [score('a', 2 / 3)])
    expect(v[0].kind).toBe('held')
    expect(regressions(v)).toHaveLength(0)
  })

  // ...but two flakes out of three is a real drop, not noise.
  it('fails two flaked attempts out of three', () => {
    expect(regressions(compareToBaseline(baseline({ a: 1 }), [score('a', 1 / 3)]))).toHaveLength(1)
  })

  it('reports a score above its baseline as improved, not a failure', () => {
    const v = compareToBaseline(baseline({ a: 1 / 3 }), [score('a', 1)])
    expect(v[0].kind).toBe('improved')
    expect(regressions(v)).toHaveLength(0)
  })

  it('marks a task the baseline predates as unrecorded rather than failing it', () => {
    const v = compareToBaseline(baseline({ a: 1 }), [score('b', 0)])
    expect(v).toEqual([{ kind: 'unrecorded', taskId: 'b', observed: 0 }])
    expect(regressions(v)).toHaveLength(0)
  })

  // A deleted/renamed task is the registration check's job, not the benchmark's.
  it('ignores a baseline task that did not run', () => {
    expect(compareToBaseline(baseline({ a: 1, gone: 1 }), [score('a', 1)])).toHaveLength(1)
  })

  it('grades a total collapse to zero as a regression', () => {
    expect(regressions(compareToBaseline(baseline({ a: 1 }), [score('a', 0)]))).toHaveLength(1)
  })

  // A task that was already failing can't regress further — it holds at 0.
  it('holds a task whose baseline is already zero', () => {
    expect(compareToBaseline(baseline({ a: 0 }), [score('a', 0)])[0].kind).toBe('held')
  })

  it('honors an explicit tolerance', () => {
    // 2/3 is within the default tolerance, but not within a strict zero.
    expect(regressions(compareToBaseline(baseline({ a: 1 }), [score('a', 2 / 3)], 0))).toHaveLength(1)
  })

  it('defaults the tolerance to one flaked attempt out of three', () => {
    expect(DEFAULT_TOLERANCE).toBeGreaterThan(1 / 3)
    expect(DEFAULT_TOLERANCE).toBeLessThan(2 / 3)
  })
})

describe('recordBaseline', () => {
  it('records provider, model, attempts and the ISO date', () => {
    const b = recordBaseline('anthropic', 'claude-opus-4-8', 3, [score('a', 1)], new Date('2026-07-16T09:00:00Z'))
    expect(b).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      attempts: 3,
      recordedAt: '2026-07-16',
      tasks: { a: 1 }
    })
  })

  // Re-recording an unchanged run must produce no diff, or every baseline refresh
  // is unreviewable churn.
  it('sorts tasks so an unchanged re-record diffs clean', () => {
    const b = recordBaseline('p', 'm', 1, [score('z', 1), score('a', 1)], new Date('2026-07-16T00:00:00Z'))
    expect(Object.keys(b.tasks)).toEqual(['a', 'z'])
  })

  it('round-trips through the shape guard', () => {
    const b = recordBaseline('p', 'm', 3, [score('a', 2 / 3)], new Date('2026-07-16T00:00:00Z'))
    expect(isEvalBaseline(JSON.parse(JSON.stringify(b)))).toBe(true)
  })
})

describe('baselineFileName', () => {
  it('names a file per provider and model', () => {
    expect(baselineFileName('anthropic', 'claude-opus-4-8')).toBe('anthropic.claude-opus-4-8.json')
  })

  // Aggregator routes carry a slash, which would otherwise write to a subdirectory.
  it('flattens a slash in an aggregator-routed model id', () => {
    expect(baselineFileName('openrouter', 'deepseek/deepseek-r1')).toBe('openrouter.deepseek_deepseek-r1.json')
  })
})

describe('isEvalBaseline', () => {
  it.each([
    ['null', null],
    ['a string', 'nope'],
    ['a missing model', { provider: 'p', attempts: 1, recordedAt: 'x', tasks: {} }],
    ['a non-numeric attempts', { provider: 'p', model: 'm', attempts: '3', recordedAt: 'x', tasks: {} }],
    ['a missing tasks map', { provider: 'p', model: 'm', attempts: 1, recordedAt: 'x' }],
    ['a non-numeric pass rate', { provider: 'p', model: 'm', attempts: 1, recordedAt: 'x', tasks: { a: 'yes' } }],
    ['a pass rate above 1', { provider: 'p', model: 'm', attempts: 1, recordedAt: 'x', tasks: { a: 1.5 } }],
    ['a negative pass rate', { provider: 'p', model: 'm', attempts: 1, recordedAt: 'x', tasks: { a: -1 } }]
  ])('rejects %s', (_label, v) => {
    expect(isEvalBaseline(v)).toBe(false)
  })

  it('accepts a well-formed baseline', () => {
    expect(isEvalBaseline(baseline({ a: 1, b: 0 }))).toBe(true)
  })
})
