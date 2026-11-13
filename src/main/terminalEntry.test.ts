import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, ElicitationResult, PlanDecision } from '@shared/agent'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { guardTerminalExit, resolveBackgroundEvent, wireTerminalSessionBackends } from './terminalEntry'
import { readShellOutput, registerShell } from './agent/shells'
import type { SignalProcess } from './signalCleanup'
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

describe('guardTerminalExit', () => {
  // A closed terminal (SIGHUP) or a `kill` must not leave a dev server holding its
  // port: background shells lead their own process group, so the hangup never reaches
  // them and only Houston's cleanup can. POSIX only (process groups).
  it.skipIf(process.platform === 'win32')(
    'stops a running background shell on SIGHUP, then exits with 129',
    async () => {
      // Detached, as the sandbox backends spawn background shells: it leads its group,
      // and the server it starts shares that group.
      const child = spawn('/bin/sh', ['-c', 'sleep 30 & echo up; wait'], { detached: true })
      const id = registerShell('sleep 30', child)
      await vi.waitFor(() => expect(readShellOutput(id, { full: true }).stdout).toContain('up'))
      const pgid = child.pid!
      expect(() => process.kill(-pgid, 0)).not.toThrow()

      const emitter = new EventEmitter()
      let exited: (code: number) => void = () => {}
      const exitCode = new Promise<number>((r) => (exited = r))
      const proc: SignalProcess = {
        on: (sig, fn) => emitter.on(sig, fn),
        removeListener: (sig, fn) => emitter.removeListener(sig, fn),
        exit: (code) => exited(code)
      }
      const flush = vi.fn(async () => {})
      guardTerminalExit(['SIGHUP', 'SIGTERM'], { flush }, proc)
      emitter.emit('SIGHUP')
      expect(await exitCode).toBe(129)
      expect(flush).toHaveBeenCalledTimes(1)
      await vi.waitFor(() => {
        let err: NodeJS.ErrnoException | undefined
        try {
          process.kill(-pgid, 0)
        } catch (e) {
          err = e as NodeJS.ErrnoException
        }
        expect(err?.code).toBe('ESRCH')
      })
    },
    15_000
  )
})
