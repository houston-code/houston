import { describe, expect, it } from 'vitest'
import { decideApproval, isBlockedByPlan, needsApproval, type ApprovalInputs } from './approval'

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

  it('full-auto approves local reads/writes/shell (when shell is sandboxed)', () => {
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
    // The whole premise for auto-approving shell is sandbox confinement. Without it,
    // an arbitrary command runs with full user privileges — prompt every time.
    for (const policy of ['ask', 'auto-edit', 'full-auto'] as const) {
      expect(needsApproval(policy, 'shell', false, false)).toBe(true)
    }
  })

  it('still auto-approves shell in full-auto when the sandbox IS in effect', () => {
    expect(needsApproval('full-auto', 'shell', false, true)).toBe(false)
  })

  it('lets an explicit "Allow for run" override win even when unsandboxed', () => {
    // At the policy-primitive level the user opted into running unconfined for the
    // run. (The stricter loop gate, decideApproval, does NOT let a *generic* override
    // — one granted for an unrelated tool — bypass unconfined shell; see below.)
    expect(needsApproval('full-auto', 'shell', true, false)).toBe(false)
  })

  it('does not let the sandbox signal gate non-shell kinds (JS-enforced containment)', () => {
    // Reads/writes don't rely on the sandbox; the structured file tools contain them.
    expect(needsApproval('full-auto', 'read', false, false)).toBe(false)
    expect(needsApproval('full-auto', 'write', false, false)).toBe(false)
    expect(needsApproval('auto-edit', 'write', false, false)).toBe(false)
    expect(needsApproval('ask', 'write', false, false)).toBe(true) // still strict under ask
  })
})

describe('isBlockedByPlan', () => {
  it('blocks writes, shell, and MCP in plan mode', () => {
    expect(isBlockedByPlan('plan', { kind: 'write' })).toBe(true)
    expect(isBlockedByPlan('plan', { kind: 'shell' })).toBe(true)
    expect(isBlockedByPlan('plan', { kind: 'mcp' })).toBe(true)
  })

  it('allows reads and network (no mutation) in plan mode', () => {
    expect(isBlockedByPlan('plan', { kind: 'read' })).toBe(false)
    expect(isBlockedByPlan('plan', { kind: 'network' })).toBe(false)
  })

  it('blocks a network tool flagged blockedInPlan (it changes remote state)', () => {
    expect(isBlockedByPlan('plan', { kind: 'network', blockedInPlan: true })).toBe(true)
  })

  it('blocks nothing under other policies', () => {
    for (const policy of ['ask', 'auto-edit', 'full-auto'] as const) {
      for (const kind of ['read', 'write', 'shell', 'network', 'mcp'] as const) {
        expect(isBlockedByPlan(policy, { kind })).toBe(false)
        expect(isBlockedByPlan(policy, { kind, blockedInPlan: true })).toBe(false)
      }
    }
  })
})

describe('decideApproval', () => {
  const base = (over: Partial<ApprovalInputs> = {}): ApprovalInputs => ({
    ruleAction: null,
    policy: 'ask',
    kind: 'read',
    override: false,
    shellSandboxed: true,
    shellUnsandboxedOverride: false,
    ...over
  })

  describe('tainted memory writes (memoryTainted)', () => {
    it('asks in every mode, past an allow rule and "Allow for run"', () => {
      for (const policy of ['ask', 'auto-edit', 'full-auto'] as const) {
        expect(decideApproval(base({ policy, kind: 'write', memoryTainted: true })).mustApprove).toBe(true)
      }
      expect(
        decideApproval(base({ policy: 'full-auto', kind: 'write', memoryTainted: true, ruleAction: 'allow', override: true }))
          .mustApprove
      ).toBe(true)
    })

    it('leaves an untainted memory write to the usual write rules', () => {
      expect(decideApproval(base({ policy: 'full-auto', kind: 'write' })).mustApprove).toBe(false)
      expect(decideApproval(base({ policy: 'auto-edit', kind: 'write' })).mustApprove).toBe(false)
      expect(decideApproval(base({ policy: 'ask', kind: 'write' })).mustApprove).toBe(true)
    })
  })

  describe('network reads (networkRead)', () => {
    it('full auto runs a network read without asking', () => {
      expect(decideApproval(base({ policy: 'full-auto', kind: 'network', networkRead: true })).mustApprove).toBe(false)
    })

    it('full auto still asks for a network call that is not a read', () => {
      expect(decideApproval(base({ policy: 'full-auto', kind: 'network' })).mustApprove).toBe(true)
      expect(decideApproval(base({ policy: 'full-auto', kind: 'network', networkRead: false })).mustApprove).toBe(true)
    })

    it('every other policy still asks for a network read', () => {
      for (const policy of ['ask', 'auto-edit', 'plan'] as const) {
        expect(decideApproval(base({ policy, kind: 'network', networkRead: true })).mustApprove).toBe(true)
      }
    })

    it('an ask rule still asks, even for a read in full auto', () => {
      expect(
        decideApproval(base({ policy: 'full-auto', kind: 'network', networkRead: true, ruleAction: 'ask' })).mustApprove
      ).toBe(true)
    })

    it('applies only to network calls', () => {
      expect(decideApproval(base({ policy: 'full-auto', kind: 'mcp', networkRead: true })).mustApprove).toBe(true)
    })
  })

  describe('on a confining host (shellSandboxed=true) — prior behavior preserved', () => {
    it('an allow rule skips the prompt', () => {
      expect(decideApproval(base({ ruleAction: 'allow', kind: 'shell' }))).toEqual({
        mustApprove: false,
        unsandboxedShell: false
      })
    })

    it('an ask rule forces the prompt', () => {
      expect(decideApproval(base({ ruleAction: 'ask', kind: 'read' })).mustApprove).toBe(true)
    })

    it('a generic override auto-approves shell', () => {
      expect(decideApproval(base({ kind: 'shell', override: true })).mustApprove).toBe(false)
    })

    it('full-auto auto-approves sandboxed shell', () => {
      expect(decideApproval(base({ kind: 'shell', policy: 'full-auto' })).mustApprove).toBe(false)
    })

    it('shell under ask prompts', () => {
      expect(decideApproval(base({ kind: 'shell', policy: 'ask' })).mustApprove).toBe(true)
    })

    it('an ask rule beats a generic override (per-run consent never skips an ask rule)', () => {
      expect(
        decideApproval(base({ kind: 'shell', ruleAction: 'ask', override: true })).mustApprove
      ).toBe(true)
    })
  })

  describe('on a NON-confining host (shellSandboxed=false) — the unconfined-shell gate', () => {
    it('flags shell as unsandboxed and prompts by default', () => {
      expect(decideApproval(base({ kind: 'shell', shellSandboxed: false }))).toEqual({
        mustApprove: true,
        unsandboxedShell: true
      })
    })

    it('an allow permission rule does NOT bypass the prompt (the key regression fix)', () => {
      expect(
        decideApproval(base({ kind: 'shell', shellSandboxed: false, ruleAction: 'allow' }))
      ).toEqual({ mustApprove: true, unsandboxedShell: true })
    })

    it('a generic override (granted for an unrelated tool) does NOT bypass the prompt', () => {
      expect(
        decideApproval(base({ kind: 'shell', shellSandboxed: false, override: true })).mustApprove
      ).toBe(true)
    })

    it('full-auto does NOT bypass the prompt', () => {
      expect(
        decideApproval(base({ kind: 'shell', shellSandboxed: false, policy: 'full-auto' }))
          .mustApprove
      ).toBe(true)
    })

    it('only the unconfined-shell-specific override bypasses it', () => {
      expect(
        decideApproval(
          base({ kind: 'shell', shellSandboxed: false, shellUnsandboxedOverride: true })
        )
      ).toEqual({ mustApprove: false, unsandboxedShell: true })
    })

    it('an ask rule still prompts after the unconfined-shell override (tighten-only)', () => {
      // The per-run consent stops the default every-command prompt; it is not consent
      // to skip a rule — managed/project or the user's own — that says "always ask".
      expect(
        decideApproval(
          base({
            kind: 'shell',
            shellSandboxed: false,
            ruleAction: 'ask',
            shellUnsandboxedOverride: true
          })
        )
      ).toEqual({ mustApprove: true, unsandboxedShell: true })
    })

    it('an ask-rule prompt keeps the unsandboxed banner even without the override', () => {
      expect(
        decideApproval(base({ kind: 'shell', shellSandboxed: false, ruleAction: 'ask' }))
      ).toEqual({ mustApprove: true, unsandboxedShell: true })
    })

    it('the override still auto-approves an allow-ruled command (no over-tightening)', () => {
      expect(
        decideApproval(
          base({
            kind: 'shell',
            shellSandboxed: false,
            ruleAction: 'allow',
            shellUnsandboxedOverride: true
          })
        )
      ).toEqual({ mustApprove: false, unsandboxedShell: true })
    })

    it('non-shell kinds are unaffected by the unconfined-shell gate', () => {
      expect(
        decideApproval(base({ kind: 'write', shellSandboxed: false, policy: 'auto-edit' }))
      ).toEqual({ mustApprove: false, unsandboxedShell: false })
      expect(decideApproval(base({ kind: 'read', shellSandboxed: false })).mustApprove).toBe(false)
    })
  })

  describe('shell command that discards work (shellDiscardsWork=true)', () => {
    it('prompts under full-auto, which would otherwise auto-approve', () => {
      expect(
        decideApproval(base({ kind: 'shell', policy: 'full-auto', shellDiscardsWork: true }))
          .mustApprove
      ).toBe(true)
    })

    it('prompts despite a generic override (Allow for run)', () => {
      expect(
        decideApproval(base({ kind: 'shell', override: true, shellDiscardsWork: true })).mustApprove
      ).toBe(true)
    })

    it('prompts on an unconfined host even after the unconfined-shell consent', () => {
      expect(
        decideApproval(
          base({
            kind: 'shell',
            policy: 'full-auto',
            shellSandboxed: false,
            shellUnsandboxedOverride: true,
            shellDiscardsWork: true
          })
        )
      ).toEqual({ mustApprove: true, unsandboxedShell: true })
    })

    it('an explicit allow rule still allows it on a confining host', () => {
      expect(
        decideApproval(base({ kind: 'shell', ruleAction: 'allow', shellDiscardsWork: true }))
          .mustApprove
      ).toBe(false)
    })

    it('a command that keeps the work is unaffected (auto-approves under full-auto)', () => {
      expect(
        decideApproval(base({ kind: 'shell', policy: 'full-auto', shellDiscardsWork: false }))
          .mustApprove
      ).toBe(false)
    })
  })

  describe('workspace-escaping shell command (shellEscapesWorkspace=true)', () => {
    it('prompts under full-auto, which would otherwise auto-approve', () => {
      expect(
        decideApproval(
          base({ kind: 'shell', policy: 'full-auto', shellEscapesWorkspace: true })
        ).mustApprove
      ).toBe(true)
    })

    it('prompts despite a generic override', () => {
      expect(
        decideApproval(base({ kind: 'shell', override: true, shellEscapesWorkspace: true }))
          .mustApprove
      ).toBe(true)
    })

    it('an explicit allow rule still allows it', () => {
      expect(
        decideApproval(
          base({ kind: 'shell', ruleAction: 'allow', shellEscapesWorkspace: true })
        ).mustApprove
      ).toBe(false)
    })

    it('does not affect non-shell kinds', () => {
      expect(
        decideApproval(
          base({ kind: 'read', policy: 'full-auto', shellEscapesWorkspace: true })
        ).mustApprove
      ).toBe(false)
    })

    it('a clean in-workspace command is unaffected (auto-approves under full-auto)', () => {
      expect(
        decideApproval(
          base({ kind: 'shell', policy: 'full-auto', shellEscapesWorkspace: false })
        ).mustApprove
      ).toBe(false)
    })
  })

  describe('credential-file read (sensitiveRead=true)', () => {
    it('prompts under full-auto, which would otherwise never prompt a read', () => {
      expect(
        decideApproval(base({ kind: 'read', policy: 'full-auto', sensitiveRead: true })).mustApprove
      ).toBe(true)
    })

    it('prompts under auto-edit too', () => {
      expect(
        decideApproval(base({ kind: 'read', policy: 'auto-edit', sensitiveRead: true })).mustApprove
      ).toBe(true)
    })

    it('a read override (allow for run) clears it', () => {
      expect(
        decideApproval(
          base({ kind: 'read', policy: 'full-auto', sensitiveRead: true, override: true })
        ).mustApprove
      ).toBe(false)
    })

    it('an explicit allow rule clears it', () => {
      expect(
        decideApproval(base({ kind: 'read', ruleAction: 'allow', sensitiveRead: true })).mustApprove
      ).toBe(false)
    })

    it('a deny-adjacent ask rule still prompts', () => {
      expect(
        decideApproval(base({ kind: 'read', ruleAction: 'ask', sensitiveRead: true })).mustApprove
      ).toBe(true)
    })

    it('does not affect an ordinary (non-sensitive) read', () => {
      expect(
        decideApproval(base({ kind: 'read', policy: 'full-auto', sensitiveRead: false })).mustApprove
      ).toBe(false)
    })
  })

  describe('credential-file write (sensitiveWrite=true)', () => {
    it('prompts a write or shell command under full-auto', () => {
      for (const kind of ['write', 'shell'] as const) {
        expect(
          decideApproval(base({ kind, policy: 'full-auto', sensitiveWrite: true })).mustApprove
        ).toBe(true)
      }
    })

    it('prompts a write under auto-edit, which otherwise auto-approves writes', () => {
      expect(
        decideApproval(base({ kind: 'write', policy: 'auto-edit', sensitiveWrite: true })).mustApprove
      ).toBe(true)
    })

    it('an override (allow for run) or an explicit allow rule clears it', () => {
      expect(
        decideApproval(base({ kind: 'write', policy: 'full-auto', sensitiveWrite: true, override: true }))
          .mustApprove
      ).toBe(false)
      expect(
        decideApproval(base({ kind: 'write', ruleAction: 'allow', sensitiveWrite: true })).mustApprove
      ).toBe(false)
    })

    it('does not affect ordinary writes, or reads', () => {
      expect(
        decideApproval(base({ kind: 'write', policy: 'full-auto', sensitiveWrite: false })).mustApprove
      ).toBe(false)
      expect(
        decideApproval(base({ kind: 'read', policy: 'full-auto', sensitiveWrite: true })).mustApprove
      ).toBe(false)
    })
  })
})
