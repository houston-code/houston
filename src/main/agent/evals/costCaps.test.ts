import { describe, expect, it } from 'vitest'
import { COST_CAP_REMINDER_FRACTION } from '../budget'
import {
  DEFAULT_ATTEMPT_MAX_COST_USD,
  RunSpend,
  capsEnforceable,
  capsLabel,
  formatCap,
  formatUsd,
  runAttempts,
  runCapError,
  runCapTaskError
} from './costCaps'

/** An attempt that bills `costUsd`, counting how many were started. */
function attempts(costs: number[]): { started: () => number; next: () => Promise<{ costUsd: number }> } {
  let i = 0
  return {
    started: () => i,
    next: async () => ({ costUsd: costs[i++] ?? 0 })
  }
}

describe('the default per-attempt cap', () => {
  /**
   * The loop's cap is not inert: it reminds the model to wrap up at a fraction of the
   * cap. The costliest archived Haiku attempt was about $0.26, and the inferred worst
   * Opus attempt about $8 (costCaps.ts), so the reminder must sit above both or it
   * changes how normal attempts end.
   */
  it('reminds the model to wrap up only far above the costliest attempt seen', () => {
    const reminderAt = DEFAULT_ATTEMPT_MAX_COST_USD * COST_CAP_REMINDER_FRACTION
    expect(reminderAt).toBeGreaterThanOrEqual(2 * 8)
    expect(reminderAt / 0.26).toBeGreaterThan(50)
  })
})

describe('runAttempts', () => {
  it('runs every attempt when there is no run cap', async () => {
    const spend = new RunSpend(undefined)
    const a = attempts([100, 100, 100])
    const out = await runAttempts('t', 3, spend, a.next)
    expect(out.complete).toBe(true)
    expect(out.results).toHaveLength(3)
    expect(spend.spentUsd).toBe(300)
    expect(spend.reached()).toBe(false)
    expect(spend.skipped).toEqual([])
  })

  it('runs every attempt that starts under the cap, including the one that crosses it', async () => {
    const spend = new RunSpend(1)
    const a = attempts([0.4, 0.4, 0.4])
    const out = await runAttempts('t', 3, spend, a.next)
    // 0.4 and 0.8 are under the cap, so the third starts and takes the run to 1.2.
    expect(out).toMatchObject({ complete: true })
    expect(a.started()).toBe(3)
    expect(spend.spentUsd).toBeCloseTo(1.2, 10)
    expect(spend.reached()).toBe(true)
    // Nothing was cut short, so nothing was skipped.
    expect(spend.skipped).toEqual([])
  })

  it('starts no attempt once the run has spent its cap, and marks the task skipped', async () => {
    const spend = new RunSpend(1)
    const a = attempts([0.6, 0.6, 0.6])
    const out = await runAttempts('t', 3, spend, a.next)
    expect(out.complete).toBe(false)
    expect(out.results).toHaveLength(2)
    expect(a.started()).toBe(2)
    expect(spend.skipped).toEqual(['t'])
  })

  // "Reached" is the loop's reading of a cap too (overCostCap): spending exactly the cap stops.
  it('treats spending exactly the cap as reaching it', async () => {
    const spend = new RunSpend(1)
    const out = await runAttempts('t', 2, spend, attempts([1, 1]).next)
    expect(out).toMatchObject({ complete: false })
    expect(out.results).toHaveLength(1)
  })

  it('skips every later task without starting it, in run order, each named once', async () => {
    const spend = new RunSpend(0.5)
    await runAttempts('a', 2, spend, attempts([0.5, 0.5]).next)
    const b = attempts([1])
    const out = await runAttempts('b', 2, spend, b.next)
    await runAttempts('c', 1, spend, attempts([1]).next)
    expect(b.started()).toBe(0)
    expect(out).toEqual({ results: [], complete: false })
    spend.skip('a')
    expect(spend.skipped).toEqual(['a', 'b', 'c'])
  })

  // A scripted fake bills nothing, and a model with no known price reports 0: neither
  // must count as having reached a cap.
  it('never reaches a cap on zero-cost attempts', async () => {
    const spend = new RunSpend(0.01)
    const out = await runAttempts('t', 5, spend, attempts([0, 0, 0, 0, 0]).next)
    expect(out.complete).toBe(true)
  })
})

describe('run cap messages', () => {
  const spend = new RunSpend(5)
  spend.add(5.123)
  spend.skip('semver-ranges')
  spend.skip('shell-allow-rule-bypass')

  it('fails a task the cap cut short, saying how far it got', () => {
    expect(runCapTaskError('semver-ranges', 1, 3, spend)).toBe(
      'Task "semver-ranges" stopped after 1 of 3 attempts: the run reached its cost cap ' +
        '(HOUSTON_EVAL_MAX_RUN_USD=5) after spending $5.12. It is not graded, and the run fails.'
    )
    expect(runCapTaskError('shell-allow-rule-bypass', 0, 3, spend)).toMatch(/^Task "shell-allow-rule-bypass" was not run:/)
  })

  it('fails the run naming every skipped task, and says why that is not a pass', () => {
    const msg = runCapError(spend)
    expect(msg).toContain('HOUSTON_EVAL_MAX_RUN_USD=5)')
    expect(msg).toContain('after spending $5.12, so 2 task(s)')
    expect(msg).toContain('semver-ranges, shell-allow-rule-bypass')
    expect(msg).toMatch(/not a pass/)
  })
})

describe('capsLabel', () => {
  it('names both caps, or says there is no run cap', () => {
    expect(capsLabel({ attemptUsd: 20, runUsd: 5 })).toBe('$20/attempt, $5/run')
    expect(capsLabel({ attemptUsd: 20 })).toBe('$20/attempt, no run cap')
    expect(capsLabel(undefined)).toBeUndefined()
  })

  // Equal labels are how a comparison decides the caps matched, so a cap is never rounded.
  it('tells apart caps that differ by less than a cent', () => {
    expect(capsLabel({ attemptUsd: 20, runUsd: 0.012 })).toBe('$20/attempt, $0.012/run')
    expect(capsLabel({ attemptUsd: 20, runUsd: 0.012 })).not.toBe(capsLabel({ attemptUsd: 20, runUsd: 0.014 }))
    expect(capsLabel({ attemptUsd: 0.001 })).not.toBe(capsLabel({ attemptUsd: 0.002 }))
    expect(formatCap(12.345)).toBe('$12.345')
  })
})

describe('formatUsd', () => {
  it('prints cents, or enough digits to tell a tiny amount from zero', () => {
    expect(formatUsd(20)).toBe('$20.00')
    expect(formatUsd(0.255)).toBe('$0.26')
    expect(formatUsd(0.0025)).toBe('$0.0025')
    expect(formatUsd(0)).toBe('$0.00')
  })
})

describe('capsEnforceable', () => {
  it('says nothing for a priced model', () => {
    expect(capsEnforceable('claude-haiku-5-5', true, { attemptUsd: 20, runUsd: 5 })).toBeUndefined()
  })

  it('warns when only the default per-attempt cap is affected', () => {
    expect(capsEnforceable('new-model', false, { attemptUsd: 20 })).toMatch(/no price for new-model.*can't be enforced/)
  })

  // A spend limit someone set and would trust must not pass as enforced.
  it('refuses a run cap it cannot enforce', () => {
    expect(() => capsEnforceable('new-model', false, { attemptUsd: 20, runUsd: 5 })).toThrow(
      /Unset HOUSTON_EVAL_MAX_RUN_USD/
    )
  })
})
