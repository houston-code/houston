import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSchedulerService } from './schedulerService'
import type { ScheduledRunInfo, ScheduledRunInput } from './agent/scheduler'

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

function makeService(opts: { fire?: (s: ScheduledRunInfo) => Promise<void> } = {}) {
  const fired: ScheduledRunInfo[] = []
  const service = createSchedulerService({
    file,
    fire: opts.fire ?? (async (s) => void fired.push({ ...s })),
    warn: (m) => warns.push(m)
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
    expect(onDisk.schemaVersion).toBe(1)
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
})
