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

  it('defaults to assuming the sandbox is in effect (back-compat)', () => {
    // The 4-arg form omitting `sandboxed` behaves as before: full-auto shell auto-approves.
    expect(needsApproval('full-auto', 'shell', false)).toBe(false)
  })

  it('never silently auto-approves shell when the sandbox is NOT in effect', () => {
    // The whole premise for auto-approving shell is Seatbelt confinement. Without
    // it, an arbitrary command runs with full user privileges — prompt every time.
    for (const policy of ['ask', 'auto-edit', 'full-auto'] as const) {
      expect(needsApproval(policy, 'shell', false, false)).toBe(true)
    }
  })

  it('still auto-approves shell in full-auto when the sandbox IS in effect', () => {
    expect(needsApproval('full-auto', 'shell', false, true)).toBe(false)
  })

  it('lets an explicit "Allow for run" override win even when unsandboxed', () => {
    // The user opted into running unconfined for the rest of the run.
    expect(needsApproval('full-auto', 'shell', true, false)).toBe(false)
  })

  it('does not let the sandbox signal gate non-shell kinds (JS-enforced containment)', () => {
    // Reads/writes don't rely on Seatbelt; the structured file tools contain them.
    expect(needsApproval('full-auto', 'read', false, false)).toBe(false)
    expect(needsApproval('full-auto', 'write', false, false)).toBe(false)
    expect(needsApproval('auto-edit', 'write', false, false)).toBe(false)
    expect(needsApproval('ask', 'write', false, false)).toBe(true) // still strict under ask
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
