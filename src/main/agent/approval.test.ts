import { describe, expect, it } from 'vitest'
import { isBlockedByPlan, needsApproval } from './approval'

describe('needsApproval', () => {
  it('auto-approves everything once "Allow for run" (override) is set', () => {
    for (const kind of ['read', 'write', 'shell', 'network'] as const) {
      expect(needsApproval('ask', kind, true)).toBe(false)
      expect(needsApproval('full-auto', kind, true)).toBe(false)
    }
  })

  it('always prompts for network egress, even in full-auto', () => {
    expect(needsApproval('ask', 'network', false)).toBe(true)
    expect(needsApproval('auto-edit', 'network', false)).toBe(true)
    expect(needsApproval('full-auto', 'network', false)).toBe(true)
  })

  it('full-auto approves local reads/writes/shell', () => {
    expect(needsApproval('full-auto', 'read', false)).toBe(false)
    expect(needsApproval('full-auto', 'write', false)).toBe(false)
    expect(needsApproval('full-auto', 'shell', false)).toBe(false)
  })

  it('never prompts for reads', () => {
    expect(needsApproval('ask', 'read', false)).toBe(false)
    expect(needsApproval('auto-edit', 'read', false)).toBe(false)
  })

  it('prompts for writes only under the strict "ask" policy', () => {
    expect(needsApproval('ask', 'write', false)).toBe(true)
    expect(needsApproval('auto-edit', 'write', false)).toBe(false)
  })

  it('prompts for shell under ask and auto-edit', () => {
    expect(needsApproval('ask', 'shell', false)).toBe(true)
    expect(needsApproval('auto-edit', 'shell', false)).toBe(true)
  })
})

describe('isBlockedByPlan', () => {
  it('blocks writes and shell in plan mode', () => {
    expect(isBlockedByPlan('plan', 'write')).toBe(true)
    expect(isBlockedByPlan('plan', 'shell')).toBe(true)
  })

  it('allows reads and network (no mutation) in plan mode', () => {
    expect(isBlockedByPlan('plan', 'read')).toBe(false)
    expect(isBlockedByPlan('plan', 'network')).toBe(false)
  })

  it('blocks nothing under other policies', () => {
    for (const policy of ['ask', 'auto-edit', 'full-auto'] as const) {
      for (const kind of ['read', 'write', 'shell', 'network'] as const) {
        expect(isBlockedByPlan(policy, kind)).toBe(false)
      }
    }
  })
})
