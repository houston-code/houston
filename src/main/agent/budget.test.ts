import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BUDGET_LIMITS,
  FINAL_STEP_FALLBACK,
  isFinalStep,
  landingReminder,
  resolveBudgetLimits,
  shouldLand,
  resolveExtensionLimits,
  shouldExtend,
  extensionNotice,
  DEFAULT_ITERATION_CEILING,
  PROGRESS_TOOLS,
  isDiscoveryTool,
  type BudgetLimits,
  type ExtensionState
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

describe('isFinalStep', () => {
  it('is true only on the last allowed iteration', () => {
    const l = resolveBudgetLimits({ maxIterations: 40 })
    expect(isFinalStep(38, l)).toBe(false)
    expect(isFinalStep(39, l)).toBe(true)
  })

  it('never treats a one-step budget as final, so its only step can still use tools', () => {
    expect(isFinalStep(0, resolveBudgetLimits({ maxIterations: 1 }))).toBe(false)
  })

  it('keeps the user-facing fallback free of em dashes', () => {
    expect(FINAL_STEP_FALLBACK).not.toContain('\u2014')
  })
})

describe('PROGRESS_TOOLS', () => {
  it('counts file edits and writable subagents, not scheduling', () => {
    for (const t of ['write_file', 'edit_file', 'multi_edit', 'apply_patch', 'notebook_edit', 'dispatch_writable_agent']) {
      expect(PROGRESS_TOOLS.has(t)).toBe(true)
    }
    for (const t of ['schedule_run', 'cancel_scheduled_run', 'run_shell', 'todo_write', 'read_file']) {
      expect(PROGRESS_TOOLS.has(t)).toBe(false)
    }
  })
})

describe('progress-aware extension', () => {
  const base = resolveBudgetLimits({ maxIterations: 40 })
  const ext = resolveExtensionLimits(base)
  const writesIn = (from: number, to: number): Set<number> => {
    const s = new Set<number>()
    for (let i = from; i < to; i++) s.add(i)
    return s
  }
  const at = (iteration: number, over: Partial<ExtensionState> = {}): ExtensionState => ({
    iteration,
    writeIterations: writesIn(0, iteration),
    discoveryIterations: new Set(),
    lastStallNudge: null,
    alreadyLanded: false,
    ...over
  })

  it('defaults to on, stepping by the base cap up to the default ceiling', () => {
    expect(ext).toEqual({ enabled: true, ceiling: DEFAULT_ITERATION_CEILING, step: 40 })
  })

  it('is off when disabled, or when the ceiling does not exceed the base cap', () => {
    expect(resolveExtensionLimits(base, { autoExtend: false }).enabled).toBe(false)
    expect(resolveExtensionLimits(base, { ceiling: 40 }).enabled).toBe(false)
    expect(resolveExtensionLimits(base, { ceiling: 10 })).toMatchObject({
      enabled: false,
      ceiling: 40
    })
    expect(resolveExtensionLimits(resolveBudgetLimits({ maxIterations: 500 })).enabled).toBe(false)
  })

  it('ignores an invalid ceiling override', () => {
    expect(resolveExtensionLimits(base, { ceiling: Number.NaN }).ceiling).toBe(
      DEFAULT_ITERATION_CEILING
    )
    expect(resolveExtensionLimits(base, { ceiling: 0 }).ceiling).toBe(DEFAULT_ITERATION_CEILING)
  })

  it('extends a productive run exactly where the landing nudge would fire', () => {
    // margin 3: iteration 37 has 3 left
    expect(shouldExtend(at(36), base, ext)).toEqual({ extend: false })
    expect(shouldExtend(at(37), base, ext)).toEqual({ extend: true, maxIterations: 80 })
    expect(shouldLand({ iteration: 37, costUsd: 0, alreadyLanded: false }, base).land).toBe(true)
  })

  it('does not extend a run without recent writes', () => {
    expect(shouldExtend(at(37, { writeIterations: new Set() }), base, ext).extend).toBe(false)
    // Writes long ago, none in the recent window.
    expect(shouldExtend(at(37, { writeIterations: writesIn(0, 20) }), base, ext).extend).toBe(false)
    // Two recent productive steps is below the bar; three meets it.
    expect(shouldExtend(at(37, { writeIterations: writesIn(35, 37) }), base, ext).extend).toBe(false)
    expect(shouldExtend(at(37, { writeIterations: writesIn(34, 37) }), base, ext).extend).toBe(true)
  })

  it('extends a run that keeps discovering something new, without writes', () => {
    const none = new Set<number>()
    // Six of the last ten steps found something new: an investigation, not a loop.
    expect(
      shouldExtend(at(37, { writeIterations: none, discoveryIterations: writesIn(31, 37) }), base, ext)
    ).toEqual({ extend: true, maxIterations: 80 })
    // Five is below the bar.
    expect(
      shouldExtend(at(37, { writeIterations: none, discoveryIterations: writesIn(32, 37) }), base, ext)
        .extend
    ).toBe(false)
    // Discovery long ago, none in the recent window.
    expect(
      shouldExtend(at(37, { writeIterations: none, discoveryIterations: writesIn(0, 25) }), base, ext)
        .extend
    ).toBe(false)
  })

  it('counts writes and discovery together toward the active bar, once per step', () => {
    // Two writes alone miss the write bar; with four discovery steps the window has six
    // active steps.
    expect(
      shouldExtend(
        at(37, { writeIterations: writesIn(35, 37), discoveryIterations: writesIn(31, 35) }),
        base,
        ext
      ).extend
    ).toBe(true)
    // A step that both wrote and discovered counts once: 5 distinct active steps.
    expect(
      shouldExtend(
        at(37, { writeIterations: writesIn(35, 37), discoveryIterations: writesIn(32, 37) }),
        base,
        ext
      ).extend
    ).toBe(false)
  })

  it('does not extend a discovering run after a recent stall nudge', () => {
    const state = at(37, {
      writeIterations: new Set(),
      discoveryIterations: writesIn(27, 37),
      lastStallNudge: 30
    })
    expect(shouldExtend(state, base, ext).extend).toBe(false)
  })

  it('does not extend after a recent stall nudge', () => {
    expect(shouldExtend(at(37, { lastStallNudge: 33 }), base, ext).extend).toBe(false)
    expect(shouldExtend(at(37, { lastStallNudge: 20 }), base, ext).extend).toBe(true)
  })

  it('does not extend once the landing nudge has fired (e.g. cost ceiling)', () => {
    expect(shouldExtend(at(37, { alreadyLanded: true }), base, ext).extend).toBe(false)
  })

  it('clamps to the ceiling and stops extending there', () => {
    const limits = { ...base, maxIterations: 180 }
    expect(shouldExtend(at(177), limits, ext)).toEqual({ extend: true, maxIterations: 200 })
    expect(shouldExtend(at(197), { ...base, maxIterations: 200 }, ext).extend).toBe(false)
  })

  it('still extends with a zero landing margin, on the final step', () => {
    const limits = resolveBudgetLimits({ maxIterations: 40, landingMargin: 0 })
    const e = resolveExtensionLimits(limits)
    expect(shouldExtend(at(38), limits, e).extend).toBe(false)
    expect(shouldExtend(at(39), limits, e).extend).toBe(true)
  })

  it('words the notice without an em dash and names both limits', () => {
    const msg = extensionNotice(80, 200)
    expect(msg).toContain('80')
    expect(msg).toContain('200')
    expect(msg).not.toContain('—')
  })
})

describe('isDiscoveryTool', () => {
  it('counts reads, commands, and outside lookups', () => {
    expect(isDiscoveryTool('read_file', 'read')).toBe(true)
    expect(isDiscoveryTool('search_files', 'read')).toBe(true)
    expect(isDiscoveryTool('run_shell', 'shell')).toBe(true)
    expect(isDiscoveryTool('web_fetch', 'network')).toBe(true)
    expect(isDiscoveryTool('mcp__docs__lookup', 'mcp')).toBe(true)
  })

  it('leaves out write-kind tools, bookkeeping, and unknown tools', () => {
    expect(isDiscoveryTool('write_file', 'write')).toBe(false)
    expect(isDiscoveryTool('schedule_run', 'write')).toBe(false)
    for (const name of ['todo_write', 'recall_history', 'kill_shell', 'list_scheduled_runs', 'skill']) {
      expect(isDiscoveryTool(name, 'read')).toBe(false)
    }
    expect(isDiscoveryTool('nonexistent', undefined)).toBe(false)
  })
})
