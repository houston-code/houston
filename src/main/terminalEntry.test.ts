import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import type { AgentEvent, ElicitationResult, PlanDecision } from '@shared/agent'
import { spawn, spawnSync } from 'node:child_process'
import {
  guardTerminalExit,
  onFirstPrompt,
  resolveBackgroundEvent,
  runHeadlessEntry,
  runScheduleDaemonEntry,
  waitForBackgroundSessionsUnless,
  watchOutputClosed,
  watchTerminationSignals,
  wireTerminalSessionBackends
} from './terminalEntry'
import { parseHeadlessArgs } from './headless'
import { daemonPidPath, runningDaemonPid } from './scheduleDaemon'
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
describe('watchTerminationSignals', () => {
  function fakeProcess() {
    const emitter = new EventEmitter()
    const exits: number[] = []
    const proc = {
      on: (e: string, h: () => void) => emitter.on(e, h),
      off: (e: string, h: () => void) => emitter.off(e, h),
      exit: (code?: number) => void exits.push(code ?? 0)
    } as unknown as Pick<NodeJS.Process, 'on' | 'off' | 'exit'>
    return { emitter, exits, proc }
  }

  it('hands the first signal over, force-exits 128+n on the second, and unsubscribes', () => {
    const { emitter, exits, proc } = fakeProcess()
    const seen: string[] = []
    const stop = watchTerminationSignals((s) => void seen.push(s), proc)
    for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) expect(emitter.listenerCount(s)).toBe(1)
    emitter.emit('SIGTERM')
    expect(seen).toEqual(['SIGTERM'])
    expect(exits).toEqual([])
    emitter.emit('SIGINT')
    expect(seen).toEqual(['SIGTERM'])
    expect(exits).toEqual([130])
    stop()
    for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) expect(emitter.listenerCount(s)).toBe(0)
  })
})

describe('watchOutputClosed', () => {
  /** A stdout whose reader has gone: every write fails with EPIPE. */
  const brokenPipe = (): Writable =>
    new Writable({
      write: (_chunk, _enc, cb) => cb(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    })

  it('turns a closed pipe into one stop call instead of an uncaught error', async () => {
    const out = brokenPipe()
    const closed: string[] = []
    const stop = watchOutputClosed(out, (e) => closed.push((e as NodeJS.ErrnoException).code ?? ''))
    out.write('answer\n')
    out.write('more\n')
    await new Promise((r) => setImmediate(r))
    expect(closed).toEqual(['EPIPE'])
    stop()
    expect(out.listenerCount('error')).toBe(0)
  })
})

describe('waitForBackgroundSessionsUnless', () => {
  it('stops waiting for background sessions that never finish once stopped settles', async () => {
    const lines: string[] = []
    let stop!: () => void
    const stopped = new Promise<void>((r) => (stop = r))
    const waiting = waitForBackgroundSessionsUnless(
      { pendingBackgroundSessions: () => 2, waitForBackgroundSessions: () => new Promise(() => {}) },
      stopped,
      (s) => lines.push(s)
    )
    stop()
    expect(await waiting).toBe(true)
    expect(lines.join('')).toBe('· waiting for 2 background sessions to finish…\n')
  })

  it('waits for sessions that finish, and says nothing when there are none', async () => {
    const lines: string[] = []
    const never = new Promise<void>(() => {})
    expect(
      await waitForBackgroundSessionsUnless(
        { pendingBackgroundSessions: () => 1, waitForBackgroundSessions: async () => {} },
        never,
        (s) => lines.push(s)
      )
    ).toBe(false)
    expect(
      await waitForBackgroundSessionsUnless(
        { pendingBackgroundSessions: () => 0, waitForBackgroundSessions: () => never },
        never,
        (s) => lines.push(s)
      )
    ).toBe(false)
    expect(lines).toEqual(['· waiting for 1 background session to finish…\n'])
  })
})

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
    // quickly) — the wait must settle and the completion note must fire, saying it
    // failed rather than that it finished.
    expect(handle.pendingBackgroundSessions()).toBe(1)
    await handle.waitForBackgroundSessions()
    expect(handle.pendingBackgroundSessions()).toBe(0)
    const note = notes.find((n) => n.startsWith('background session'))
    expect(note).toMatch(/^background session ".*" failed\. Resume it to see the result/)
    expect(note).not.toContain('finished')
    // The /sessions list says the same.
    expect(handle.backgroundSessions()).toEqual([
      expect.objectContaining({ id: result.conversationId, running: false, outcome: 'error' })
    ])
  })

  it('strips control characters from a spawned session title in its completion note', async () => {
    const notes: string[] = []
    const handle = wireTerminalSessionBackends({ notify: (m) => notes.push(m), startScheduler: false })
    await spawnSession({
      prompt: 'do a thing on your own',
      title: 'evil \x1b]52;c;QQ==\x07 title \x1b[2J',
      providerId: 'anthropic',
      model: 'claude-test',
      approvalPolicy: 'ask',
      workspace: dir
    })
    await handle.waitForBackgroundSessions()
    const note = notes.find((n) => n.startsWith('background session')) ?? ''
    expect(note).toContain('evil ')
    expect(note).not.toContain('\x1b')
    expect(note).not.toContain('\x07')
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

describe('onFirstPrompt', () => {
  const nextTurn = (): Promise<void> => new Promise((r) => setImmediate(r))

  it('runs the deferred work once, just after the first composer read has drawn its prompt', async () => {
    const events: string[] = []
    const io = onFirstPrompt(
      {
        readComposer: async (prompt: string | (() => string)) => {
          events.push(`draw:${typeof prompt === 'string' ? prompt : prompt()}`)
          return 'typed'
        }
      },
      () => events.push('deferred')
    )
    const first = io.readComposer!('› ')
    // Not inside the read: the prompt reaches the screen first.
    expect(events).toEqual(['draw:› '])
    await expect(first).resolves.toBe('typed')
    await nextTurn()
    expect(events).toEqual(['draw:› ', 'deferred'])
    await io.readComposer!(() => '» ')
    await nextTurn()
    expect(events).toEqual(['draw:› ', 'deferred', 'draw:» '])
  })

  it('leaves an io without a composer as it is', () => {
    const io = {}
    expect(onFirstPrompt(io, () => {})).toBe(io)
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

describe('runScheduleDaemonEntry', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'houston-daemon-entry-'))
    setUserDataDir(dir)
  })
  afterEach(() => {
    resetSpawnBackend()
    resetSchedulerBackend()
    resetUserDataDir()
    rmSync(dir, { recursive: true, force: true })
  })

  /** A signal source that records listeners and never exits the test process. */
  function fakeSignals(): SignalProcess & { emitter: EventEmitter; exits: number[] } {
    const emitter = new EventEmitter()
    const exits: number[] = []
    return {
      emitter,
      exits,
      on: (s, fn) => emitter.on(s, fn),
      removeListener: (s, fn) => emitter.removeListener(s, fn),
      exit: (code) => void exits.push(code)
    }
  }

  it('holds the profile pid file while it runs, wires the scheduler, and stops cleanly', async () => {
    const stop = new AbortController()
    const out: string[] = []
    const proc = fakeSignals()
    const running = runScheduleDaemonEntry({ signal: stop.signal, proc, out: (s) => out.push(s), appRunning: () => false })
    await vi.waitFor(() => expect(runningDaemonPid(dir)).toBe(process.pid))
    expect(isSchedulerConfigured()).toBe(true)
    for (const s of ['SIGHUP', 'SIGTERM', 'SIGINT']) expect(proc.emitter.listenerCount(s)).toBe(1)
    expect(out.join('')).toMatch(/^Houston schedule daemon running \(pid \d+\)/)
    stop.abort()
    expect(await running).toBe(0)
    expect(existsSync(daemonPidPath(dir))).toBe(false)
    for (const s of ['SIGHUP', 'SIGTERM', 'SIGINT']) expect(proc.emitter.listenerCount(s)).toBe(0)
  })

  it('stops on a signal, releasing the pid file before exiting 128+n', async () => {
    const proc = fakeSignals()
    void runScheduleDaemonEntry({ proc, out: () => {}, appRunning: () => false })
    await vi.waitFor(() => expect(runningDaemonPid(dir)).toBe(process.pid))
    proc.emitter.emit('SIGTERM')
    await vi.waitFor(() => expect(proc.exits).toEqual([143]))
    expect(existsSync(daemonPidPath(dir))).toBe(false)
  })

  it('exits at once when another daemon already runs for the profile', async () => {
    // A live process other than this one: the parent of the test runner.
    writeFileSync(daemonPidPath(dir), String(process.ppid))
    const out: string[] = []
    expect(await runScheduleDaemonEntry({ out: (s) => out.push(s), proc: fakeSignals() })).toBe(0)
    expect(out.join('')).toBe(`The schedule daemon is already running (pid ${process.ppid}).\n`)
    expect(isSchedulerConfigured()).toBe(false)
  })
})

describe('runHeadlessEntry', () => {
  let dir: string
  let repo: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'houston-headless-entry-'))
    setUserDataDir(join(dir, 'data'))
    repo = join(dir, 'repo')
    const git = (...args: string[]): void => {
      const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
      if (r.status !== 0) throw new Error(r.stderr)
    }
    mkdirSync(repo)
    git('init', '-q', '-b', 'main')
    git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'first')
  })
  afterEach(() => {
    resetSpawnBackend()
    resetSchedulerBackend()
    resetUserDataDir()
    rmSync(dir, { recursive: true, force: true })
  })

  it.skipIf(process.platform === 'win32')('leaves no -w worktree behind for a launch refused before its run', async () => {
    const opts = parseHeadlessArgs(['-p', 'fix it', '-w', 'refused-run', '--mcp-config', join(dir, 'nope.json')], repo)!
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    expect(await runHeadlessEntry(opts)).toBe(2)
    const list = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8' }).stdout
    expect(list).not.toContain('refused-run')
    const branches = spawnSync('git', ['branch', '--list', 'refused-run'], { cwd: repo, encoding: 'utf8' }).stdout
    expect(branches.trim()).toBe('')
    vi.restoreAllMocks()
  })
})
