import { describe, expect, it } from 'vitest'
import {
  AGGREGATE_ALPHA,
  DEFAULT_TOLERANCE,
  assertRecordable,
  baselineFileName,
  compareAggregate,
  compareToBaseline,
  isDeadBaseline,
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

  // Probes are an A/B instrument: even a baseline that somehow carried a probe's id
  // must not let a probe row regress the gate.
  it('reports a behavior probe as unrecorded, whatever the baseline holds', () => {
    const v = compareToBaseline(baseline({ a: 1, 'probe:p': 1 }), [score('a', 1), score('probe:p', 0)])
    expect(v).toEqual([
      { kind: 'held', taskId: 'a', baseline: 1, observed: 1 },
      { kind: 'unrecorded', taskId: 'probe:p', observed: 0 }
    ])
    expect(regressions(v)).toHaveLength(0)
  })
})

describe('assertRecordable', () => {
  /**
   * REGRESSION (the all-zero baseline incident). A set-but-empty
   * HOUSTON_EVAL_MODEL made every live call fail, and the recorder happily wrote
   * 0 for all eight tasks. Committing that would have permanently disabled the
   * quality gate: nothing can regress below zero.
   */
  it('refuses a baseline where every task scored 0', () => {
    const allZero = ['a', 'b', 'c'].map((id) => score(id, 0))
    expect(() => assertRecordable(allZero)).toThrow(/all 3 tasks scored 0/)
  })

  it('explains the likely cause rather than just failing', () => {
    expect(() => assertRecordable([score('a', 0)])).toThrow(/misconfiguration/)
  })

  /**
   * REGRESSION (the out-of-credit recording). The provider account ran dry two
   * thirds of the way through; the recorder wrote the remaining tasks as 0 beside
   * real scores, and the all-zero check above did not fire.
   */
  it('refuses a run where failed attempts ended in a run error', () => {
    const scores = [score('a', 1), score('b', 0), score('c', 1 / 3)]
    const errored = [
      { taskId: 'b', attempts: 3 },
      { taskId: 'c', attempts: 2 }
    ]
    expect(() => assertRecordable(scores, errored)).toThrow(/5 attempt\(s\) across 2 task\(s\) ended in a run error/)
    expect(() => assertRecordable(scores, errored)).toThrow(/Tasks: b, c/)
  })

  it('records real zeros when no attempt errored', () => {
    expect(() => assertRecordable([score('a', 1), score('b', 0)], [])).not.toThrow()
  })

  // A capped attempt is a runaway the cap cut short: frozen as a 0, it could never regress.
  it('refuses a run where the per-attempt cost cap stopped an attempt', () => {
    const scores = [score('a', 1), score('b', 2 / 3), score('c', 0)]
    const capped = [
      { taskId: 'b', attempts: 1 },
      { taskId: 'c', attempts: 3 }
    ]
    expect(() => assertRecordable(scores, [], capped)).toThrow(
      /4 attempt\(s\) across 2 task\(s\) reached the per-attempt cost cap or its wrap-up reminder/
    )
    expect(() => assertRecordable(scores, [], capped)).toThrow(/Tasks: b, c/)
    expect(() => assertRecordable(scores, [], capped)).toThrow(/HOUSTON_EVAL_MAX_COST_USD/)
    expect(() => assertRecordable(scores, [], [])).not.toThrow()
  })

  it('refuses an empty score set', () => {
    expect(() => assertRecordable([])).toThrow(/no tasks/)
  })

  it('refuses a score set with a behavior probe in it', () => {
    expect(() => assertRecordable([score('a', 1), score('probe:p', 1)])).toThrow(
      /behavior probes in it \(probe:p\).*HOUSTON_EVAL_TASKS unset/
    )
  })

  // A model that genuinely can't do some tasks is a real, recordable baseline —
  // only "nothing worked at all" is treated as a misconfiguration.
  it('allows a partial-zero baseline', () => {
    expect(() => assertRecordable([score('a', 0), score('b', 1 / 3)])).not.toThrow()
  })

  it('allows a single barely-passing task', () => {
    expect(() => assertRecordable([score('a', 1 / 3)])).not.toThrow()
  })
})

describe('isDeadBaseline', () => {
  // The file the incident actually produced: shape-valid, and completely inert.
  it('flags an all-zero baseline as dead', () => {
    expect(isDeadBaseline(baseline({ a: 0, b: 0, c: 0 }))).toBe(true)
  })

  it('does not flag a baseline with any passing task', () => {
    expect(isDeadBaseline(baseline({ a: 0, b: 1 / 3 }))).toBe(false)
  })

  // An empty task map gates nothing either, but that's the registration check's
  // problem; don't claim it's the "dead gate" failure.
  it('does not flag an empty baseline', () => {
    expect(isDeadBaseline(baseline({}))).toBe(false)
  })

  it('accepts the shape guard but still reads as dead', () => {
    const b = baseline({ a: 0 })
    expect(isEvalBaseline(b)).toBe(true)
    expect(isDeadBaseline(b)).toBe(true)
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

  it('stamps the prompt hash it was recorded on, when there is one', () => {
    const now = new Date('2026-10-24T00:00:00Z')
    const stamped = recordBaseline('p', 'm', 3, [score('a', 1)], now, { promptHash: '0123456789ab' })
    expect(stamped.promptHash).toBe('0123456789ab')
    expect(isEvalBaseline(JSON.parse(JSON.stringify(stamped)))).toBe(true)
    expect('promptHash' in recordBaseline('p', 'm', 3, [score('a', 1)], now)).toBe(false)
  })

  // The effort reaches the request as a parameter, so the prompt hash can't stand in for it.
  it('stamps the reasoning effort and the commit, and leaves out what it was not given', () => {
    const now = new Date('2026-11-16T00:00:00Z')
    const stamps = { promptHash: '0123456789ab', reasoningEffort: 'high', commit: 'f0009525abcd-dirty' }
    const b = recordBaseline('p', 'm', 3, [score('a', 1)], now, stamps)
    expect(b).toMatchObject(stamps)
    expect(isEvalBaseline(JSON.parse(JSON.stringify(b)))).toBe(true)
    const bare = recordBaseline('p', 'm', 3, [score('a', 1)], now, { reasoningEffort: undefined, commit: '' })
    expect(Object.keys(bare)).toEqual(['provider', 'model', 'attempts', 'recordedAt', 'tasks'])
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
    ['a negative pass rate', { provider: 'p', model: 'm', attempts: 1, recordedAt: 'x', tasks: { a: -1 } }],
    ['a non-string prompt hash', { provider: 'p', model: 'm', attempts: 1, recordedAt: 'x', promptHash: 1, tasks: {} }],
    ['a non-string effort', { provider: 'p', model: 'm', attempts: 1, recordedAt: 'x', reasoningEffort: 3, tasks: {} }],
    ['a non-string commit', { provider: 'p', model: 'm', attempts: 1, recordedAt: 'x', commit: true, tasks: {} }]
  ])('rejects %s', (_label, v) => {
    expect(isEvalBaseline(v)).toBe(false)
  })

  it('accepts a well-formed baseline', () => {
    expect(isEvalBaseline(baseline({ a: 1, b: 0 }))).toBe(true)
  })

  // Every checked-in baseline predates the effort and commit stamps; they must still load.
  it('accepts a baseline with no stamps at all, and one with every stamp', () => {
    expect(isEvalBaseline(baseline({ a: 1 }))).toBe(true)
    expect(
      isEvalBaseline({ ...baseline({ a: 1 }), promptHash: 'aaaaaaaaaaaa', reasoningEffort: 'high', commit: 'f0009525abcd' })
    ).toBe(true)
  })
})

describe('compareAggregate', () => {
  /** A Haiku-shaped baseline: 25 tasks at 3/3, two at 1/3, one at 2/3, one at 0/3, so 79/87. */
  const ids = Array.from({ length: 29 }, (_, i) => `t${String(i + 1).padStart(2, '0')}`)
  const counts = [...Array<number>(25).fill(3), 1, 1, 2, 0]
  const haiku = baseline(Object.fromEntries(ids.map((id, i) => [id, counts[i] / 3])))
  /** The run: `passes[i]` of `attempts` on task i. */
  const run = (passes: number[], attempts = 3): TaskScore[] =>
    ids.map((taskId, i) => ({ taskId, passRate: passes[i] / attempts, attempts }))
  /** The baseline with the first `k` tasks (all perfect) one attempt down. */
  const flakes = (k: number): number[] => counts.map((c, i) => (i < k ? c - 1 : c))

  /**
   * The case the per-task tolerance can't see: 79/87 to 70/87, spread as one flake on
   * each of nine tasks. Every task holds; the run as a whole does not.
   */
  it('fails a drop spread one flake per task, which every per-task verdict passes', () => {
    const scores = run(flakes(9))
    expect(regressions(compareToBaseline(haiku, scores))).toEqual([])
    const v = compareAggregate(haiku, scores)!
    expect(v).toMatchObject({
      kind: 'regressed',
      tasks: 29,
      baseline: { passes: 79, attempts: 87 },
      run: { passes: 70, attempts: 87 },
      baselineAttempts: 3,
      runAttempts: 3,
      alpha: AGGREGATE_ALPHA
    })
    // Reference value from an independent implementation.
    expect(v.p).toBeCloseTo(0.0082421875, 10)
    expect(v.fell.map((f) => f.taskId)).toEqual(ids.slice(0, 9))
  })

  it('fails a clearly bigger drop by a wide margin', () => {
    const passes = flakes(12)
    passes[25] = 0 // and one of the 1/3 tasks to 0/3
    const v = compareAggregate(haiku, run(passes))!
    expect(v.run.passes).toBe(66)
    expect(v.kind).toBe('regressed')
    expect(v.p).toBeCloseTo(0.00050537109375, 10)
    // Biggest fall first, ties by id: the 1/3 task lost a third, the same as one flake.
    expect(v.fell.map((f) => f.taskId)).toEqual([...ids.slice(0, 12), 't26'])
    const collapse = counts.map((c, i) => (i === 20 ? 0 : i < 3 ? c - 1 : c))
    expect(compareAggregate(haiku, run(collapse))!.fell.map((f) => f.taskId)).toEqual(['t21', 't01', 't02', 't03'])
  })

  // The real A/A-sized result: main 79/87 against a branch at 77/87 with no prompt change.
  it('holds an A/A-sized wobble', () => {
    const twoDown = compareAggregate(haiku, run(flakes(2)))!
    expect(twoDown).toMatchObject({ kind: 'held', run: { passes: 77, attempts: 87 } })
    expect(twoDown.p).toBeCloseTo(0.236, 10)
    // Ups and downs together: three flakes, and a 1/3 task up to 2/3.
    const mixed = flakes(3)
    mixed[25] = 2
    const v = compareAggregate(haiku, run(mixed))!
    expect(v).toMatchObject({ kind: 'held', run: { passes: 77, attempts: 87 } })
    expect(v.p).toBeCloseTo(0.251875, 10)
  })

  it('holds a run that matches or beats its baseline', () => {
    expect(compareAggregate(haiku, run(counts))).toMatchObject({ kind: 'held', fell: [] })
    expect(compareAggregate(haiku, run(counts.map(() => 3)))!.p).toBeGreaterThan(0.9)
  })

  /**
   * eval-ab runs two attempts against the three-attempt baselines. Compared by rate, a
   * perfect 2/2 matches a perfect 3/3 (58 passes against 87 is no drop), and a real drop
   * at two attempts still fails.
   */
  it('compares a two-attempt run with a three-attempt baseline by rate', () => {
    const asGood = [...Array<number>(25).fill(2), 1, 1, 1, 0]
    const same = compareAggregate(haiku, run(asGood, 2))!
    expect(same).toMatchObject({ kind: 'held', run: { passes: 53, attempts: 58 }, baselineAttempts: 3, runAttempts: 2 })
    expect(same.p).toBeCloseTo(0.57, 10)

    const twoDown = asGood.map((c, i) => (i < 2 ? 1 : c))
    expect(compareAggregate(haiku, run(twoDown, 2))).toMatchObject({ kind: 'held' })
    const eightDown = asGood.map((c, i) => (i < 8 ? 1 : c))
    const v = compareAggregate(haiku, run(eightDown, 2))!
    expect(v.kind).toBe('regressed')
    expect(v.p).toBeCloseTo(0.00505970688, 10)
    expect(v.fell[0]).toEqual({ taskId: 't01', baseline: 1, observed: 0.5 })
  })

  // The same set the per-task verdicts compare: unrecorded tasks and tasks this run skipped are out.
  it('compares only the tasks both sides scored', () => {
    const b = baseline({ a: 1, b: 1, gone: 1 })
    const v = compareAggregate(b, [score('a', 1), score('b', 2 / 3), score('new', 0)])!
    expect(v).toMatchObject({ tasks: 2, baseline: { passes: 6, attempts: 6 }, run: { passes: 5, attempts: 6 } })
    expect(compareAggregate(b, [score('new', 0)])).toBeUndefined()
    expect(compareAggregate(b, [])).toBeUndefined()
  })

  // A probe-only run has nothing for the whole-run check to grade, and a probe in a mixed run counts for nothing.
  it('leaves behavior probes out, even under an id the baseline holds', () => {
    const b = baseline({ a: 1, 'probe:p': 1 })
    expect(compareAggregate(b, [score('probe:p', 0), score('probe:q', 0)])).toBeUndefined()
    expect(compareAggregate(b, [score('a', 1), score('probe:p', 0)])).toMatchObject({ tasks: 1, fell: [] })
  })

  it('honors an explicit level', () => {
    expect(compareAggregate(haiku, run(flakes(9)), 0.005)!.kind).toBe('held')
    expect(compareAggregate(haiku, run(flakes(2)), 0.5)!.kind).toBe('regressed')
  })

  it('sizes the default level at 1%, for a weekly run', () => {
    expect(AGGREGATE_ALPHA).toBe(0.01)
  })
})
