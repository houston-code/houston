import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, ElicitationResult, PlanDecision } from '@shared/agent'
import { resolveBackgroundEvent, wireTerminalSessionBackends } from './terminalEntry'
import { setUserDataDir, resetUserDataDir } from './userData'
import { resetSpawnBackend, isSpawnBackendConfigured, spawnSession } from './agent/spawn'
import { resetSchedulerBackend, isSchedulerConfigured, scheduleCreate, scheduleList } from './agent/scheduler'

/**
 * The terminal hosts' background sessions have no window/prompt surface, so
 * every event the loop can BLOCK on must be resolved here non-interactively —
 * the same parity contract the TUI test suite enforces for its foreground
 * prompts. A blocking event this switch drops would hang a spawned session
 * forever.
 */
describe('resolveBackgroundEvent', () => {
  function record() {
    const approvals: Array<[string, string, string]> = []
    const questions: Array<[string, string, string]> = []
    const plans: Array<[string, string, PlanDecision]> = []
    const elicitations: Array<[string, string, ElicitationResult]> = []
    return {
      approvals,
      questions,
      plans,
      elicitations,
      r: {
        resolveApproval: (runId: string, callId: string, d: 'allow' | 'deny' | 'always' | 'rule-allow' | 'rule-deny') =>
          void approvals.push([runId, callId, d]),
        resolveQuestion: (runId: string, callId: string, a: string) => void questions.push([runId, callId, a]),
        resolvePlan: (runId: string, callId: string, d: PlanDecision) => void plans.push([runId, callId, d]),
        resolveElicitation: (runId: string, elicitId: string, r2: ElicitationResult) =>
          void elicitations.push([runId, elicitId, r2])
      }
    }
  }

  it('declines approvals rather than granting them', () => {
    const { r, approvals } = record()
    resolveBackgroundEvent(
      { runId: 'r1', type: 'tool_approval', callId: 'c1', name: 'write_file', summary: 's', kind: 'write' },
      r
    )
    expect(approvals).toEqual([['r1', 'c1', 'deny']])
  })

  it('answers ask_user with a best-judgment note', () => {
    const { r, questions } = record()
    resolveBackgroundEvent(
      { runId: 'r1', type: 'tool_question', callId: 'c1', question: 'which?', options: [] },
      r
    )
    expect(questions).toHaveLength(1)
    expect(questions[0][2]).toContain('best judgment')
  })

  it('rejects a presented plan', () => {
    const { r, plans } = record()
    resolveBackgroundEvent(
      { runId: 'r1', type: 'plan_ready', callId: 'c1', plan: { title: 't' } },
      r
    )
    expect(plans).toEqual([['r1', 'c1', { kind: 'reject' }]])
  })

  it('declines an MCP elicitation rather than fabricating an answer', () => {
    const { r, elicitations } = record()
    resolveBackgroundEvent(
      {
        runId: 'r1',
        type: 'elicitation',
        callId: 'c1',
        elicitId: 'c1:e1',
        serverId: 'srv',
        message: 'API key?',
        fields: []
      },
      r
    )
    expect(elicitations).toEqual([['r1', 'c1:e1', { action: 'decline' }]])
  })

  it('resolves EVERY blocking event variant (parity guard)', () => {
    // If a new blocking AgentEvent variant is added, extend resolveBackgroundEvent
    // and this list together — a background session must never wait on a human.
    const blocking: AgentEvent['type'][] = ['tool_approval', 'tool_question', 'plan_ready', 'elicitation']
    for (const type of blocking) {
      const { r, approvals, questions, plans, elicitations } = record()
      const e =
        type === 'tool_approval'
          ? ({ runId: 'r', type, callId: 'c', name: 'n', summary: 's', kind: 'write' } as AgentEvent)
          : type === 'tool_question'
            ? ({ runId: 'r', type, callId: 'c', question: 'q', options: [] } as AgentEvent)
            : type === 'elicitation'
              ? ({ runId: 'r', type, callId: 'c', elicitId: 'e', serverId: 's', message: 'm', fields: [] } as AgentEvent)
              : ({ runId: 'r', type, callId: 'c', plan: { title: 't' } } as AgentEvent)
      resolveBackgroundEvent(e, r)
      expect(approvals.length + questions.length + plans.length + elicitations.length, type).toBe(1)
    }
  })
})

describe('wireTerminalSessionBackends', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'houston-term-'))
    setUserDataDir(dir)
  })
  afterEach(() => {
    resetSpawnBackend()
    resetSchedulerBackend()
    resetUserDataDir()
    rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('wires spawn + scheduler backends for a terminal host', () => {
    expect(isSpawnBackendConfigured()).toBe(false)
    expect(isSchedulerConfigured()).toBe(false)
    wireTerminalSessionBackends({ startScheduler: false })
    expect(isSpawnBackendConfigured()).toBe(true)
    expect(isSchedulerConfigured()).toBe(true)
  })

  it('spawns a persisted background session, notes non-interactive mode, and settles the wait', async () => {
    const notes: string[] = []
    const handle = wireTerminalSessionBackends({
      notify: (m) => notes.push(m),
      startScheduler: false
    })
    const result = await spawnSession({
      prompt: 'do a thing on your own',
      providerId: 'anthropic',
      model: 'claude-test',
      approvalPolicy: 'ask',
      workspace: dir
    })
    expect(result.conversationId).toBeTruthy()
    expect(result.note).toContain('non-interactively')
    // The background run started (agent host unconfigured here, so it errors out
    // quickly) — the wait must settle and the completion note must fire.
    expect(handle.pendingBackgroundSessions()).toBe(1)
    await handle.waitForBackgroundSessions()
    expect(handle.pendingBackgroundSessions()).toBe(0)
    expect(notes.some((n) => n.includes('finished'))).toBe(true)
  })

  it('persists schedules through the scheduler seam without starting timers', () => {
    wireTerminalSessionBackends({ startScheduler: false })
    const info = scheduleCreate({
      name: 'nightly',
      spec: 'every 30m',
      prompt: 'p',
      workspace: dir,
      providerId: 'anthropic',
      model: 'claude-test',
      approvalPolicy: 'ask'
    })
    expect(info.id).toMatch(/^sch-/)
    expect(scheduleList()).toHaveLength(1)
  })
})
