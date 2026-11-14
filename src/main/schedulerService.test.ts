import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LOCK_STALE_MS, POLL_MS, createSchedulerService, fireViaSpawn } from './schedulerService'
import {
  MAX_SCHEDULE_ERROR_CHARS,
  type ScheduledFire,
  type ScheduledRunInfo,
  type ScheduledRunInput
} from './agent/scheduler'
import type { RunOutcome } from '@shared/runEnd'
import { resetSpawnBackend, setSpawnBackend, type SpawnSessionInput } from './agent/spawn'

let dir: string
let file: string
let warns: string[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'houston-sched-'))
  file = join(dir, 'schedules.json')
  warns = []
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 6, 15, 12, 0, 0)) // Wed Jul 15 2026, noon local
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

const input = (over: Partial<ScheduledRunInput> = {}): ScheduledRunInput => ({
  name: 'nightly',
  spec: 'every 30m',
  prompt: 'do the thing',
  workspace: '/ws',
  providerId: 'anthropic',
  model: 'claude-test',
  approvalPolicy: 'ask',
  ...over
})

function makeService(
  opts: { fire?: (s: ScheduledRunInfo) => Promise<ScheduledFire | void>; lockAttempts?: number } = {}
) {
  const fired: ScheduledRunInfo[] = []
  const service = createSchedulerService({
    file,
    fire: opts.fire ?? (async (s) => void fired.push({ ...s })),
    warn: (m) => warns.push(m),
    ...(opts.lockAttempts !== undefined ? { lockAttempts: opts.lockAttempts } : {})
  })
  return { service, fired }
}

describe('createSchedulerService', () => {
  it('creates a schedule: validates + normalizes the spec, persists, computes the next fire', () => {
    const { service } = makeService()
    const info = service.create(input({ spec: 'every 30 minutes' }))
    expect(info.id).toMatch(/^sch-/)
    expect(info.spec).toBe('every 30m') // normalized description
    expect(info.nextRunAt).toBe(Date.now() + 30 * 60 * 1000)
    // Persisted (atomically) with a schema version, and reloadable by a fresh service.
    const onDisk = JSON.parse(readFileSync(file, 'utf8'))
    expect(onDisk.schemaVersion).toBe(2)
    expect(onDisk.schedules).toHaveLength(1)
    const { service: reloaded } = makeService()
    expect(reloaded.list()).toHaveLength(1)
    expect(reloaded.list()[0].id).toBe(info.id)
  })

  it('rejects a bad spec with the parser message (nothing persisted)', () => {
    const { service } = makeService()
    expect(() => service.create(input({ spec: 'every 1m' }))).toThrow(/minimum is 5 minutes/)
    expect(() => service.create(input({ spec: 'whenever' }))).toThrow(/Supported forms/)
    expect(service.list()).toHaveLength(0)
    expect(existsSync(file)).toBe(false)
  })

  it('cancels by id (and reports an unknown id as false)', () => {
    const { service } = makeService()
    const info = service.create(input())
    expect(service.cancel('sch-nope')).toBe(false)
    expect(service.cancel(info.id)).toBe(true)
    expect(service.list()).toHaveLength(0)
    expect(service.cancel(info.id)).toBe(false)
  })

  it('fires a due schedule, records the result, and re-arms for the next occurrence', async () => {
    const { service, fired } = makeService()
    service.create(input({ spec: 'every 30m' }))
    service.start()
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 5)
    expect(fired).toHaveLength(1)
    expect(fired[0].name).toBe('nightly')
    const [s] = service.list()
    expect(s.lastResult).toBe('ok')
    expect(s.lastFiredAt).toBeTruthy()
    expect(s.nextRunAt).toBe(s.lastFiredAt! + 30 * 60 * 1000)
    // Second occurrence fires from the re-armed timer.
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 5)
    expect(fired).toHaveLength(2)
  })

  it('records a failed fire (message kept, schedule keeps recurring)', async () => {
    const { service } = makeService({
      fire: async () => {
        throw new Error('Too many background sessions are already running')
      }
    })
    service.create(input())
    service.start()
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 5)
    const [s] = service.list()
    expect(s.lastResult).toBe('error')
    expect(s.lastError).toContain('Too many background sessions')
    expect(s.nextRunAt).not.toBeNull() // still scheduled for the next occurrence
  })

  it('removes a one-shot after it fires', async () => {
    const { service, fired } = makeService()
    service.create(input({ spec: 'once at 2026-07-15 12:30' }))
    service.start()
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 5)
    expect(fired).toHaveLength(1)
    expect(service.list()).toHaveLength(0)
  })

  it('fires a one-shot once even when the time zone changes before it fires', async () => {
    const zone = process.env.TZ
    try {
      process.env.TZ = 'America/New_York'
      vi.setSystemTime(new Date(2026, 6, 15, 12, 0, 0))
      const { service, fired } = makeService()
      service.create(input({ spec: 'once at 2026-07-15 12:30' }))
      // The user flies west: the stored local time "12:30" now names a later instant.
      process.env.TZ = 'America/Los_Angeles'
      service.start()
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 5)
      expect(fired).toHaveLength(1)
      // Before: re-deriving the spec in the new zone re-armed it for 12:30 Pacific.
      expect(service.list()).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000)
      expect(fired).toHaveLength(1)
      service.stop()
    } finally {
      if (zone === undefined) delete process.env.TZ
      else process.env.TZ = zone
    }
  })

  it('keeps a higher schema version a newer Houston stamped on the store', () => {
    writeFileSync(file, JSON.stringify({ schemaVersion: 7, schedules: [] }))
    const { service } = makeService()
    service.create(input())
    const onDisk = JSON.parse(readFileSync(file, 'utf8'))
    expect(onDisk.schemaVersion).toBe(7)
    expect(onDisk.schedules).toHaveLength(1)
  })

  it('catches up an occurrence missed while the host was down, once, at start()', async () => {
    // Written by a previous process: due an hour ago.
    const overdue: ScheduledRunInfo = {
      ...input(),
      id: 'sch-old',
      nextRunAt: Date.now() - 60 * 60 * 1000,
      createdAt: Date.now() - 2 * 60 * 60 * 1000
    }
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, schedules: [overdue] }))
    const { service, fired } = makeService()
    service.start()
    await vi.advanceTimersByTimeAsync(1)
    expect(fired).toHaveLength(1)
    // Realigned to the present, not to the missed slot.
    expect(service.list()[0].nextRunAt).toBe(Date.now() + 30 * 60 * 1000 - 1)
  })

  it('does not fire before start(), and stops firing after stop()', async () => {
    const { service, fired } = makeService()
    service.create(input())
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(fired).toHaveLength(0) // never started (a manage-only host)
    // Starting now catches up the occurrence that came due meanwhile (the same
    // anacron semantics as a host restart)…
    service.start()
    await vi.advanceTimersByTimeAsync(1)
    expect(fired).toHaveLength(1)
    // …and stop() disarms: nothing more fires however long we wait.
    service.stop()
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000)
    expect(fired).toHaveLength(1)
  })

  it('sets aside a corrupt store and starts empty instead of crashing or clobbering silently', () => {
    writeFileSync(file, '{not json')
    const { service } = makeService()
    expect(service.list()).toHaveLength(0)
    expect(warns.some((w) => w.includes('unreadable'))).toBe(true)
    expect(existsSync(`${file}.corrupt`)).toBe(true)
  })

  // The desktop app and a terminal session share one store file. Two services on the
  // same file stand in for the two processes.
  describe('shared by several processes', () => {
    it("keeps a schedule another process created when this one changes the store", () => {
      const { service: app } = makeService()
      const { service: tui } = makeService()
      const mine = app.create(input({ name: 'mine' }))
      const theirs = tui.create(input({ name: 'theirs' }))
      // Before: the app's stale copy wrote over the terminal's schedule here.
      expect(app.cancel(mine.id)).toBe(true)
      expect(tui.list().map((s) => s.id)).toEqual([theirs.id])
      expect(app.list().map((s) => s.id)).toEqual([theirs.id])
      expect(existsSync(`${file}.lock`)).toBe(false)
    })

    it('fires a schedule created in another process', async () => {
      const { service: app, fired } = makeService()
      app.start()
      const { service: cli } = makeService() // manage-only: never started
      cli.create(input({ spec: 'every 30m' }))
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + POLL_MS)
      expect(fired).toHaveLength(1)
      expect(cli.list()[0].lastResult).toBe('ok')
      app.stop()
    })

    it('fires each occurrence once when two running hosts share the store', async () => {
      const a = makeService()
      a.service.create(input({ spec: 'every 30m' }))
      // The second host starts with the schedule already on disk, as after a restart.
      const b = makeService()
      a.service.start()
      b.service.start()
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + POLL_MS)
      expect(a.fired.length + b.fired.length).toBe(1)
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
      expect(a.fired.length + b.fired.length).toBe(2)
      a.service.stop()
      b.service.stop()
    })

    it('breaks a lock left by a process that died holding it', () => {
      writeFileSync(`${file}.lock`, '2147483646') // no such process
      const { service } = makeService()
      service.create(input())
      expect(service.list()).toHaveLength(1)
      expect(existsSync(`${file}.lock`)).toBe(false)
      expect(warns).toEqual([])
    })

    it('breaks a lock older than LOCK_STALE_MS even when its pid is alive (reused)', () => {
      const lock = `${file}.lock`
      writeFileSync(lock, String(process.pid)) // a live pid, as after pid reuse
      const old = (Date.now() - LOCK_STALE_MS - 1000) / 1000
      utimesSync(lock, old, old)
      const { service } = makeService()
      service.create(input())
      expect(service.list()).toHaveLength(1)
      expect(existsSync(lock)).toBe(false)
      expect(warns).toEqual([])
    })

    it('does not break a fresh lock held by a live process', () => {
      const lock = `${file}.lock`
      writeFileSync(lock, String(process.pid))
      const now = Date.now() / 1000
      utimesSync(lock, now, now)
      // A short wait: the point is what happens once it runs out, not its length.
      const { service } = makeService({ lockAttempts: 3 })
      service.create(input())
      // Waited out, then went ahead without it; the holder's lock is left in place.
      expect(warns).toEqual([`could not lock ${file}; updating schedules without the lock`])
      expect(readFileSync(lock, 'utf8')).toBe(String(process.pid))
    })

    it('skips the lock and the read on an idle poll, and still sees another process edit', async () => {
      const lock = `${file}.lock`
      const { service: app, fired } = makeService()
      app.start()
      // A held lock: any poll that tried to take it would wait it out and warn.
      writeFileSync(lock, String(process.pid))
      const now = Date.now() / 1000
      utimesSync(lock, now, now)
      await vi.advanceTimersByTimeAsync(5 * POLL_MS)
      expect(warns).toEqual([])
      expect(readFileSync(lock, 'utf8')).toBe(String(process.pid))
      rmSync(lock)
      // Another process adds a schedule: the store's stamp changes, so the next poll
      // reads it and the run fires on time.
      const { service: cli } = makeService()
      cli.create(input({ spec: 'every 30m' }))
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + POLL_MS)
      expect(fired).toHaveLength(1)
      app.stop()
    })

    it('fires a schedule read at startup when it comes due, with the store unchanged', async () => {
      makeService().service.create(input({ spec: 'every 30m' }))
      const { service, fired } = makeService()
      service.start()
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000 - 1000)
      expect(fired).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(1000 + 5)
      expect(fired).toHaveLength(1)
      service.stop()
    })

    it('does not fire a schedule another process cancelled while this one idled', async () => {
      const { service: cli } = makeService()
      const info = cli.create(input({ spec: 'every 30m' }))
      const { service: app, fired } = makeService()
      app.start()
      await vi.advanceTimersByTimeAsync(POLL_MS)
      expect(cli.cancel(info.id)).toBe(true)
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
      expect(fired).toHaveLength(0)
      app.stop()
    })
  })
})

describe('fireViaSpawn', () => {
  const spawned: SpawnSessionInput[] = []
  beforeEach(() => {
    spawned.length = 0
    setSpawnBackend({
      spawn: async (i) => {
        spawned.push(i)
        return { conversationId: 'c', title: i.title ?? '', workspace: i.workspace }
      }
    })
  })
  afterEach(() => resetSpawnBackend())

  const stored = (over: Partial<ScheduledRunInfo> = {}): ScheduledRunInfo => ({
    ...input(),
    id: 'sch-1',
    nextRunAt: null,
    createdAt: 0,
    ...over
  })

  it("starts each occurrence on the schedule's stored effort and policy", async () => {
    await fireViaSpawn(() => undefined)(stored({ reasoningEffort: 'low', approvalPolicy: 'auto-edit' }))
    expect(spawned[0]).toMatchObject({ reasoningEffort: 'low', approvalPolicy: 'auto-edit', model: 'claude-test' })
  })

  it('leaves the effort to the default for a schedule without one', async () => {
    await fireViaSpawn(() => undefined)(stored())
    expect(spawned[0]).not.toHaveProperty('reasoningEffort')
  })

  it('coerces a hand-edited unknown policy to plan and drops an unknown effort', async () => {
    await fireViaSpawn(() => undefined)(stored({ approvalPolicy: 'yolo' as never, reasoningEffort: 'max' as never }))
    expect(spawned[0].approvalPolicy).toBe('plan')
    expect(spawned[0]).not.toHaveProperty('reasoningEffort')
  })
})

describe('reasoning effort on a stored schedule', () => {
  it('survives the store round trip', () => {
    const { service } = makeService()
    service.create(input({ reasoningEffort: 'xhigh' }))
    expect(service.list()[0].reasoningEffort).toBe('xhigh')
    expect(JSON.parse(readFileSync(file, 'utf8')).schedules[0].reasoningEffort).toBe('xhigh')
  })
})

describe('pause, resume and run now', () => {
  it('a paused schedule never fires, and resuming skips what came due meanwhile', async () => {
    const { service, fired } = makeService()
    const info = service.create(input({ spec: 'every 30m' }))
    service.start()
    expect(service.setPaused(info.id, true)?.paused).toBe(true)
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000)
    expect(fired).toHaveLength(0)
    // Survives a reload from disk.
    expect(makeService().service.list()[0].paused).toBe(true)
    const resumed = service.setPaused(info.id, false)!
    expect(resumed.paused).toBeUndefined()
    expect(resumed.nextRunAt).toBe(Date.now() + 30 * 60 * 1000)
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 5)
    expect(fired).toHaveLength(1)
  })

  it('reports an unknown id', () => {
    const { service } = makeService()
    expect(service.setPaused('sch-nope', true)).toBeNull()
  })

  it('runs one occurrence now without moving the next planned run', async () => {
    const { service, fired } = makeService()
    const info = service.create(input({ spec: 'daily at 09:00' }))
    await service.runNow(info.id)
    expect(fired.map((s) => s.id)).toEqual([info.id])
    const [s] = service.list()
    expect(s.nextRunAt).toBe(info.nextRunAt)
    expect(s.lastFiredAt).toBe(Date.now())
    expect(s.lastResult).toBe('ok')
  })

  it('runs a paused schedule on request, and records a run that could not start', async () => {
    const { service } = makeService({
      fire: async () => {
        throw new Error('Too many background sessions')
      }
    })
    const info = service.create(input())
    service.setPaused(info.id, true)
    await expect(service.runNow(info.id)).rejects.toThrow('Too many background sessions')
    const [s] = service.list()
    expect(s).toMatchObject({ lastResult: 'error', lastError: 'Too many background sessions', paused: true })
    await expect(service.runNow('sch-nope')).rejects.toThrow('no longer exists')
  })
})

describe('how a fired run ended', () => {
  /** A fire whose run stays in flight until the test ends it with `finish`. */
  function controlledFire() {
    const runs: { conversationId: string; finish: (o: RunOutcome) => void }[] = []
    let n = 0
    const fire = async (): Promise<ScheduledFire> => {
      const conversationId = `conv-${++n}`
      let finish!: (o: RunOutcome) => void
      const ended = new Promise<RunOutcome>((resolve) => (finish = resolve))
      runs.push({ conversationId, finish })
      return { conversationId, ended }
    }
    return { fire, runs }
  }

  it('shows a run still in flight as running, not ok, then ok once it finishes cleanly', async () => {
    const { fire, runs } = controlledFire()
    const { service } = makeService({ fire })
    const info = service.create(input())
    await service.runNow(info.id)
    expect(service.list()[0]).toMatchObject({ lastResult: 'running', lastRunConversationId: 'conv-1' })
    // Another process reading the store sees the same.
    expect(makeService().service.list()[0].lastResult).toBe('running')
    runs[0].finish({ outcome: 'done' })
    await vi.advanceTimersByTimeAsync(0)
    const [s] = service.list()
    expect(s.lastResult).toBe('ok')
    expect(s.lastError).toBeUndefined()
  })

  it('records a run that failed, hit a limit, or was stopped, with the failure message', async () => {
    const { fire, runs } = controlledFire()
    const { service } = makeService({ fire })
    const info = service.create(input())

    await service.runNow(info.id)
    runs[0].finish({ outcome: 'error', message: 'The provider rejected the key.' })
    await vi.advanceTimersByTimeAsync(0)
    expect(service.list()[0]).toMatchObject({ lastResult: 'error', lastError: 'The provider rejected the key.' })

    await service.runNow(info.id)
    expect(service.list()[0].lastError).toBeUndefined() // a new run clears the old failure
    runs[1].finish({ outcome: 'limit', limit: 'stalled' })
    await vi.advanceTimersByTimeAsync(0)
    expect(service.list()[0]).toMatchObject({ lastResult: 'limit', lastLimit: 'stalled' })

    await service.runNow(info.id)
    runs[2].finish({ outcome: 'stopped' })
    await vi.advanceTimersByTimeAsync(0)
    const [s] = service.list()
    expect(s.lastResult).toBe('stopped')
    expect(s.lastLimit).toBeUndefined()
  })

  it('records the outcome of a timer-fired run too', async () => {
    const { fire, runs } = controlledFire()
    const { service } = makeService({ fire })
    service.create(input({ spec: 'every 30m' }))
    service.start()
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 5)
    expect(service.list()[0].lastResult).toBe('running')
    runs[0].finish({ outcome: 'limit', limit: 'max-steps' })
    await vi.advanceTimersByTimeAsync(0)
    expect(service.list()[0]).toMatchObject({ lastResult: 'limit', lastLimit: 'max-steps' })
    service.stop()
  })

  it("doesn't let an earlier run's end overwrite a later run that is still going", async () => {
    const { fire, runs } = controlledFire()
    const { service } = makeService({ fire })
    const info = service.create(input())
    await service.runNow(info.id)
    await service.runNow(info.id)
    runs[0].finish({ outcome: 'error', message: 'old run failed' })
    await vi.advanceTimersByTimeAsync(0)
    expect(service.list()[0]).toMatchObject({ lastResult: 'running', lastRunConversationId: 'conv-2' })
  })

  it('caps a long failure message', async () => {
    const { fire, runs } = controlledFire()
    const { service } = makeService({ fire })
    const info = service.create(input())
    await service.runNow(info.id)
    runs[0].finish({ outcome: 'error', message: 'x'.repeat(10_000) })
    await vi.advanceTimersByTimeAsync(0)
    expect(service.list()[0].lastError!.length).toBeLessThanOrEqual(MAX_SCHEDULE_ERROR_CHARS)
  })

  /** A store left mid-run by the host with `pid`. */
  function writeRunningStore(pid: number) {
    const s: ScheduledRunInfo = {
      ...input(),
      id: 'sch-orphan',
      nextRunAt: Date.now() + 60 * 60 * 1000,
      createdAt: 0,
      lastFiredAt: Date.now() - 1000,
      lastResult: 'running',
      lastRunConversationId: 'conv-x',
      lastRunPid: pid
    }
    writeFileSync(file, JSON.stringify({ schemaVersion: 2, schedules: [s] }))
  }
  // Above every platform's pid range, so no process has it.
  const DEAD_PID = 2_147_483_000

  it("doesn't leave a run stuck running after the host that ran it quit", () => {
    writeRunningStore(DEAD_PID)
    const [s] = makeService().service.list()
    expect(s.lastResult).toBe('error')
    expect(s.lastError).toMatch(/Houston closed before this run finished/)
    // Written back, so every reader agrees.
    expect(JSON.parse(readFileSync(file, 'utf8')).schedules[0].lastResult).toBe('error')
  })

  it('settles an orphaned run at start(), before anything lists it', () => {
    writeRunningStore(DEAD_PID)
    const { service } = makeService()
    service.start()
    expect(JSON.parse(readFileSync(file, 'utf8')).schedules[0].lastResult).toBe('error')
    service.stop()
  })

  it('leaves a run alone while the host running it is still alive', () => {
    writeRunningStore(process.pid)
    expect(makeService().service.list()[0].lastResult).toBe('running')
  })

  it("treats a version 1 store's ok as unknown: it only meant the run started", () => {
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        schedules: [{ ...input(), id: 'sch-old', nextRunAt: null, createdAt: 0, lastFiredAt: 5, lastResult: 'ok' }]
      })
    )
    const [s] = makeService().service.list()
    expect(s.lastFiredAt).toBe(5)
    expect(s.lastResult).toBeUndefined()
  })
})

describe('fireViaSpawn run outcome', () => {
  afterEach(() => resetSpawnBackend())

  it('resolves the run outcome once the spawned session ends, read from its chat', async () => {
    let end!: () => void
    setSpawnBackend({
      spawn: async (i) => {
        end = () => i.onRunEnd?.()
        return { conversationId: 'c-9', title: i.title ?? '', workspace: i.workspace }
      }
    })
    const outcomes: Record<string, RunOutcome> = { 'c-9': { outcome: 'limit', limit: 'max-output' } }
    const handle = await fireViaSpawn((id) => outcomes[id])({ ...input(), id: 'sch-1', nextRunAt: null, createdAt: 0 })
    expect(handle.conversationId).toBe('c-9')
    let settled: RunOutcome | undefined
    void handle.ended!.then((o) => (settled = o))
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBeUndefined() // still in flight
    end()
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toEqual({ outcome: 'limit', limit: 'max-output' })
  })

  it('reports a run whose chat is gone as stopped', async () => {
    setSpawnBackend({
      spawn: async (i) => {
        queueMicrotask(() => i.onRunEnd?.())
        return { conversationId: 'c-gone', title: '', workspace: i.workspace }
      }
    })
    const handle = await fireViaSpawn(() => undefined)({ ...input(), id: 'sch-1', nextRunAt: null, createdAt: 0 })
    expect(await handle.ended).toEqual({ outcome: 'stopped' })
  })
})

