import { describe, expect, it } from 'vitest'
import type { AppSettings } from '@shared/types'
import { autoExtendTurnsEnabled } from '@shared/defaults'
import { applyRunOverrides } from './run-overrides'
import { resolveBudgetLimits, resolveExtensionLimits } from './budget'
import { shouldVerify } from './verify-gate'

const saved = (over: Partial<AppSettings> = {}): AppSettings =>
  ({
    schemaVersion: 1,
    providers: [],
    selected: null,
    approvalPolicy: 'ask',
    recentWorkspaces: [],
    reasoningEffort: 'low',
    ...over
  }) as unknown as AppSettings

describe('applyRunOverrides', () => {
  it('returns the saved settings untouched when there are no overrides', () => {
    const s = saved()
    expect(applyRunOverrides(s, undefined)).toBe(s)
    expect(applyRunOverrides(s, {})).toEqual(s)
  })

  it('lays each override over the saved value without mutating the saved settings', () => {
    const s = saved({ maxIterations: 40, costCeilingUsd: 9, verifyOnStop: false, verifyCommand: 'make' })
    const run = applyRunOverrides(s, {
      reasoningEffort: 'xhigh',
      maxIterations: 7,
      costCeilingUsd: 1.5,
      verifyCommand: 'npm test'
    })
    expect(run).toMatchObject({
      reasoningEffort: 'xhigh',
      maxIterations: 7,
      costCeilingUsd: 1.5,
      verifyOnStop: true,
      verifyCommand: 'npm test'
    })
    // Run-only: the saved settings object never sees the overrides.
    expect(s).toMatchObject({ reasoningEffort: 'low', maxIterations: 40, costCeilingUsd: 9, verifyOnStop: false })
  })

  it('turns memory off for the run without touching the saved setting', () => {
    const s = saved({ memoryEnabled: true })
    expect(applyRunOverrides(s, { memoryEnabled: false }).memoryEnabled).toBe(false)
    expect(s.memoryEnabled).toBe(true)
  })

  it('leaves the fields it does not override alone', () => {
    const run = applyRunOverrides(saved({ maxIterations: 12, verifyCommand: 'make' }), { reasoningEffort: 'high' })
    expect(run.maxIterations).toBe(12)
    expect(run.verifyCommand).toBe('make')
    expect(run.verifyOnStop).toBeUndefined()
  })

  it('makes a max-turns override a hard cap, even over a saved auto-extend preference', () => {
    const run = applyRunOverrides(saved({ autoExtendTurns: true }), { maxIterations: 5 })
    expect(autoExtendTurnsEnabled(run)).toBe(false)
    const budget = resolveBudgetLimits({ maxIterations: run.maxIterations, costCeilingUsd: run.costCeilingUsd })
    expect(budget.maxIterations).toBe(5)
    expect(resolveExtensionLimits(budget, { autoExtend: autoExtendTurnsEnabled(run) }).enabled).toBe(false)
  })

  it('feeds the cost override into the budget as its ceiling', () => {
    const run = applyRunOverrides(saved(), { costCeilingUsd: 2 })
    expect(resolveBudgetLimits({ maxIterations: run.maxIterations, costCeilingUsd: run.costCeilingUsd }).costCeilingUsd).toBe(2)
  })

  it('arms the verification gate with the override command', () => {
    const run = applyRunOverrides(saved(), { verifyCommand: 'pytest -q' })
    const gate = {
      enabled: run.verifyOnStop === true,
      command: run.verifyCommand,
      filesModified: true,
      passesRun: 0,
      maxPasses: 1,
      policy: 'full-auto' as const
    }
    expect(shouldVerify(gate)).toBe(true)
    // Still never in plan mode, and still only after an edit.
    expect(shouldVerify({ ...gate, policy: 'plan' })).toBe(false)
    expect(shouldVerify({ ...gate, filesModified: false })).toBe(false)
  })
})
