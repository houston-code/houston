import { describe, expect, it } from 'vitest'
import type { TaskReport } from './report'
import {
  RUN_RECORD_VERSION,
  compareRuns,
  currentCommit,
  formatComparison,
  isRunRecord,
  toRunRecord,
  type EvalRunRecord
} from './runRecord'
import type { EvalResult } from './types'

const sample: EvalResult = {
  taskId: 't',
  passed: true,
  exitCode: 0,
  verifyOutput: '',
  toolsUsed: [],
  durationMs: 10,
  costUsd: 0,
  honesty: { unsupportedClaims: [], falseClaims: [], undisclosedFailures: [], todoGaps: [], honest: true }
}

const report = (taskId: string, passRate: number, honestyRate?: number): TaskReport => ({
  taskId,
  attempts: 3,
  passRate,
  sample,
  costUsd: 0.5,
  durationMs: 1000,
  ...(honestyRate === undefined ? {} : { honestyRate })
})

const meta = {
  driver: 'live' as const,
  provider: 'anthropic',
  model: 'claude-haiku-5-5',
  attempts: 3,
  promptHash: 'aaaaaaaaaaaa',
  commit: 'f0009525abcd',
  host: 'darwin'
}

/** A live record over `tasks` (taskId -> passes out of 3). */
const run = (tasks: Record<string, number>, over: Partial<EvalRunRecord> = {}): EvalRunRecord => ({
  version: RUN_RECORD_VERSION,
  ...meta,
  recordedAt: '2026-10-24T00:00:00.000Z',
  tasks: Object.fromEntries(
    Object.entries(tasks).map(([id, passes]) => [id, { passes, costUsd: 0.01, durationMs: 1000 }])
  ),
  ...over
})

describe('toRunRecord', () => {
  it('stores pass counts, not rounded rates, sorted by task', () => {
    const r = toRunRecord(meta, [report('b', 2 / 3, 1), report('a', 1)], new Date('2026-10-24T12:00:00Z'))
    expect(Object.keys(r.tasks)).toEqual(['a', 'b'])
    expect(r.tasks.b).toEqual({ passes: 2, honest: 3, costUsd: 0.5, durationMs: 1000 })
    // No honesty grade, no honest count: absent is not the same as zero.
    expect(r.tasks.a).toEqual({ passes: 3, costUsd: 0.5, durationMs: 1000 })
    expect(r).toMatchObject({ version: 1, ...meta, recordedAt: '2026-10-24T12:00:00.000Z' })
    expect(isRunRecord(r)).toBe(true)
  })

  it('leaves out stamps it does not have', () => {
    const r = toRunRecord({ ...meta, promptHash: undefined, commit: undefined }, [report('a', 1)], new Date())
    expect('promptHash' in r).toBe(false)
    expect('commit' in r).toBe(false)
  })
})

describe('isRunRecord', () => {
  it('accepts a well-formed record', () => {
    expect(isRunRecord(run({ a: 3 }))).toBe(true)
  })

  it.each([
    ['a future version', { version: 2 }],
    ['an unknown driver', { driver: 'replay' }],
    ['zero attempts', { attempts: 0 }],
    ['a non-string prompt hash', { promptHash: 7 }],
    ['no host', { host: undefined }]
  ])('rejects %s', (_name, over) => {
    expect(isRunRecord({ ...run({ a: 3 }), ...over })).toBe(false)
  })

  it('rejects a task with more passes than attempts', () => {
    expect(isRunRecord(run({ a: 4 }))).toBe(false)
  })

  it('rejects a fractional pass count (a rate written where a count belongs)', () => {
    expect(isRunRecord(run({ a: 0.67 }))).toBe(false)
  })

  it('rejects junk', () => {
    expect(isRunRecord(null)).toBe(false)
    expect(isRunRecord('{}')).toBe(false)
  })
})

describe('currentCommit', () => {
  const git =
    (sha: string, status: string) =>
    (args: string[]): string =>
      args[0] === 'rev-parse' ? `${sha}\n` : status

  it('names a clean checkout by its short sha', () => {
    expect(currentCommit(git('f0009525abcd', ''))).toBe('f0009525abcd')
  })

  // The usual A/B is main vs an uncommitted edit; both would otherwise name one commit.
  it('marks a checkout with tracked changes as dirty', () => {
    expect(currentCommit(git('f0009525abcd', ' M src/main/agent/prompt.ts\n'))).toBe('f0009525abcd-dirty')
  })

  it('gives up quietly when git is unavailable', () => {
    expect(
      currentCommit(() => {
        throw new Error('spawn git ENOENT')
      })
    ).toBeUndefined()
  })
})

describe('compareRuns', () => {
  it('pairs tasks and counts wins, losses and ties from B’s side', () => {
    const c = compareRuns(run({ a: 3, b: 1, c: 2 }), run({ a: 2, b: 3, c: 2 }))
    expect(c.shared.map((t) => [t.taskId, Math.round(t.delta * 3)])).toEqual([
      ['a', -1],
      ['b', 2],
      ['c', 0]
    ])
    expect(c).toMatchObject({ wins: 1, losses: 1, ties: 1, p: 1 })
    expect(c.meanDelta).toBeCloseTo(1 / 9, 10)
  })

  it('calls a sweep significant', () => {
    const a = run({ t1: 0, t2: 0, t3: 0, t4: 0, t5: 0, t6: 0, t7: 3, t8: 3 })
    const b = run({ t1: 3, t2: 3, t3: 2, t4: 3, t5: 1, t6: 3, t7: 3, t8: 3 })
    const c = compareRuns(a, b)
    expect(c).toMatchObject({ wins: 6, losses: 0, ties: 2 })
    expect(c.p).toBeLessThan(0.05)
  })

  it('compares only the tasks both runs scored, and names the rest', () => {
    const c = compareRuns(run({ a: 3, old: 3 }), run({ a: 3, added: 0 }))
    expect(c.shared.map((t) => t.taskId)).toEqual(['a'])
    expect(c.onlyA).toEqual(['old'])
    expect(c.onlyB).toEqual(['added'])
    // The unshared tasks stay out of the totals too.
    expect(c.b).toMatchObject({ tasks: 1, passes: 3, attempts: 3 })
  })

  it('compares runs with different attempt counts by rate', () => {
    const c = compareRuns(run({ a: 3 }), run({ a: 4 }, { attempts: 5 }))
    expect(c.shared[0]).toMatchObject({ a: 1, b: 0.8 })
    expect(c.losses).toBe(1)
    expect(c.differs).toContain('attempts')
  })

  it('names the stamps that differ', () => {
    const c = compareRuns(run({ a: 3 }), run({ a: 3 }, { promptHash: 'bbbbbbbbbbbb', commit: 'f0009525abcd-dirty' }))
    expect(c.differs).toEqual(['prompt', 'commit'])
  })

  // Scripted passes by construction, so the "difference" would be the drivers.
  it('refuses to compare a scripted run with a live one', () => {
    expect(() => compareRuns(run({ a: 3 }), run({ a: 3 }, { driver: 'scripted' }))).toThrow(/scripted/)
  })

  it('refuses two runs with no task in common', () => {
    expect(() => compareRuns(run({ a: 3 }), run({ b: 3 }))).toThrow(/share no tasks/)
  })
})

describe('formatComparison', () => {
  const a = run({ fix: 3, rename: 1 })
  const b = run({ fix: 2, rename: 3 }, { promptHash: 'bbbbbbbbbbbb' })
  const text = formatComparison(compareRuns(a, b), a, b, { a: 'main.json', b: 'branch.json' })

  it('labels both sides with their files and stamps', () => {
    expect(text).toContain('A = main.json')
    expect(text).toContain('B = branch.json')
    expect(text).toContain('prompt aaaaaaaaaaaa')
    expect(text).toContain('prompt bbbbbbbbbbbb')
    expect(text).toContain('differs: prompt')
  })

  it('shows each task’s pass counts and the delta in points', () => {
    expect(text).toMatch(/fix\s+3\/3\s+2\/3\s+-33/)
    expect(text).toMatch(/rename\s+1\/3\s+3\/3\s+\+67/)
  })

  it('prints each side’s interval and reliability', () => {
    expect(text).toMatch(/A: attempts 4\/6 = 67% \(95% CI \d+%–\d+%\)\s+pass@3 2\/2\s+pass\^3 1\/2/)
  })

  it('says plainly when the difference is not significant', () => {
    expect(text).toContain('better on 1, worse on 1, tied on 0')
    expect(text).toContain('No significant difference (sign test p = 1.000)')
  })

  it('says so when no task moved', () => {
    const same = formatComparison(compareRuns(a, a), a, a, { a: 'x', b: 'y' })
    expect(same).toContain('No task changed')
    expect(same).toContain('differs: nothing recorded')
  })

  it('names the winner of a significant comparison', () => {
    const worse = run({ t1: 0, t2: 0, t3: 0, t4: 0, t5: 0, t6: 0 })
    const better = run({ t1: 3, t2: 3, t3: 3, t4: 3, t5: 3, t6: 3 })
    expect(formatComparison(compareRuns(worse, better), worse, better, { a: 'x', b: 'y' })).toContain(
      'B is BETTER than A'
    )
    expect(formatComparison(compareRuns(better, worse), better, worse, { a: 'x', b: 'y' })).toContain(
      'B is WORSE than A'
    )
  })
})
