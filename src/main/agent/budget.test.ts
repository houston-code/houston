import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BUDGET_LIMITS,
  landingReminder,
  resolveBudgetLimits,
  shouldLand,
  type BudgetLimits
} from './budget'

describe('resolveBudgetLimits', () => {
  it('falls back to defaults for undefined/invalid input', () => {
    expect(resolveBudgetLimits()).toEqual(DEFAULT_BUDGET_LIMITS)
    expect(resolveBudgetLimits({ maxIterations: 0 }).maxIterations).toBe(
      DEFAULT_BUDGET_LIMITS.maxIterations
    )
    expect(resolveBudgetLimits({ maxIterations: -5 }).maxIterations).toBe(
      DEFAULT_BUDGET_LIMITS.maxIterations
    )
  })

  it('accepts and floors a valid iteration cap', () => {
    expect(resolveBudgetLimits({ maxIterations: 12.9 }).maxIterations).toBe(12)
  })

  it('clamps landingMargin into [0, maxIterations-1]', () => {
    expect(resolveBudgetLimits({ maxIterations: 5, landingMargin: 100 }).landingMargin).toBe(4)
    expect(resolveBudgetLimits({ maxIterations: 5, landingMargin: -1 }).landingMargin).toBe(
      DEFAULT_BUDGET_LIMITS.landingMargin
    )
    expect(resolveBudgetLimits({ maxIterations: 1, landingMargin: 3 }).landingMargin).toBe(0)
  })

  it('treats a non-positive cost ceiling as disabled', () => {
    expect(resolveBudgetLimits({ costCeilingUsd: 0 }).costCeilingUsd).toBe(0)
    expect(resolveBudgetLimits({ costCeilingUsd: -1 }).costCeilingUsd).toBe(0)
    expect(resolveBudgetLimits({ costCeilingUsd: 2.5 }).costCeilingUsd).toBe(2.5)
  })
})

const limits = (over: Partial<BudgetLimits> = {}): BudgetLimits => ({
  ...DEFAULT_BUDGET_LIMITS,
  ...over
})

describe('shouldLand', () => {
  it('does not land early in a run', () => {
    const l = limits({ maxIterations: 40, landingMargin: 3 })
    expect(shouldLand({ iteration: 0, costUsd: 0, alreadyLanded: false }, l).land).toBe(false)
    expect(shouldLand({ iteration: 30, costUsd: 0, alreadyLanded: false }, l).land).toBe(false)
  })

  it('lands within the margin of the cap', () => {
    const l = limits({ maxIterations: 40, landingMargin: 3 })
    // iterationsLeft = maxIterations - iteration = 40 - 37 = 3, which is <= the
    // landingMargin of 3, so the steps trigger fires.
    const d = shouldLand({ iteration: 37, costUsd: 0, alreadyLanded: false }, l)
    expect(d.land).toBe(true)
    expect(d.iterationsLeft).toBe(3)
    expect(d.trigger).toBe('steps')
  })

  it('lands when the cost ceiling is crossed even far from the cap', () => {
    const l = limits({ maxIterations: 40, landingMargin: 3, costCeilingUsd: 1 })
    const over = shouldLand({ iteration: 2, costUsd: 1.5, alreadyLanded: false }, l)
    expect(over.land).toBe(true)
    // Far from the iteration cap, so this is a cost-driven landing, not a steps one.
    expect(over.trigger).toBe('cost')
    expect(shouldLand({ iteration: 2, costUsd: 0.5, alreadyLanded: false }, l).land).toBe(false)
  })

  it('does not use the cost trigger when the ceiling is 0 (disabled)', () => {
    const l = limits({ maxIterations: 40, landingMargin: 3, costCeilingUsd: 0 })
    expect(shouldLand({ iteration: 2, costUsd: 9999, alreadyLanded: false }, l).land).toBe(false)
  })

  it('never lands twice (one-time nudge)', () => {
    const l = limits({ maxIterations: 40, landingMargin: 3 })
    expect(shouldLand({ iteration: 38, costUsd: 0, alreadyLanded: true }, l).land).toBe(false)
  })
})

describe('landingReminder', () => {
  it('renders a singular vs plural step count and mentions wrapping up', () => {
    expect(landingReminder(1)).toMatch(/1 step\b/)
    expect(landingReminder(3)).toMatch(/3 steps\b/)
    expect(landingReminder(0)).toMatch(/0 steps\b/)
    expect(landingReminder(-2)).toMatch(/0 steps\b/) // clamped
    expect(landingReminder(2)).toMatch(/wrap up/i)
  })

  it('phrases the cost trigger without a step count (steps would mislead)', () => {
    const msg = landingReminder(25, 'cost')
    expect(msg).toMatch(/cost budget/i)
    expect(msg).toMatch(/wrap up/i)
    // Many iterations may remain, so it must not cite a "N steps left" figure.
    expect(msg).not.toMatch(/\bsteps? left\b/i)
    expect(msg).not.toMatch(/25/)
  })

  it('defaults to the steps phrasing', () => {
    expect(landingReminder(3)).toBe(landingReminder(3, 'steps'))
  })
})
