import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  parseScheduleSpec,
  nextOccurrence,
  describeSpec,
  type ScheduleSpec
} from './agent/schedule-spec'
import type {
  SchedulerBackend,
  ScheduledRunInfo,
  ScheduledRunInput
} from './agent/scheduler'
import { spawnSession, isSpawnBackendConfigured } from './agent/spawn'
import { getUserDataDir } from './userData'
import { log } from './logger'

/**
 * The store + timer engine behind scheduled runs — the shell-side implementation
 * of the seam in `agent/scheduler.ts`, mirroring how `spawnSession.ts` backs
 * `agent/spawn.ts`.
 *
 * Schedules persist as one JSON file under the profile directory (shared by the
 * desktop app and CLI the same way conversations are), so a schedule created in
 * a chat survives restarts. Firing is in-process: a single timer armed for the
 * earliest `nextRunAt`; each due schedule starts a fresh background session
 * through the spawn seam, so a fired run is an ordinary conversation (visible in
 * the sidebar / `/resume`) and inherits the spawn concurrency cap. Occurrences
 * missed while Houston was closed fire once at the next `start()` — anacron
 * semantics, so a "daily at 9" still happens on a machine that was asleep at 9 —
 * and then the schedule realigns to its normal cadence.
 *
 * Everything host-specific is injected: hosts that only manage schedules (the
 * one-shot headless CLI) create the service and never `start()` it, so creating/
 * listing/cancelling works everywhere while timers only run in long-lived hosts.
 */

/** Persisted shape. Bump + migrate in load() when the schema changes. */
const SCHEDULES_SCHEMA_VERSION = 1

interface PersistedSchedules {
  schemaVersion: number
  schedules: ScheduledRunInfo[]
}

/** Where schedules live, under the shared per-user profile. */
export function schedulesFilePath(): string {
  return join(getUserDataDir(), 'schedules.json')
}

export interface SchedulerServiceDeps {
  /** Absolute path of the JSON store (schedulesFilePath() in production). */
  file: string
  /** Start one occurrence's background session. Rejections mark the schedule's lastResult. */
  fire: (schedule: ScheduledRunInfo) => Promise<void>
  /** Clock, injectable for tests. */
  now?: () => number
  warn?: (message: string) => void
}

export interface SchedulerService extends SchedulerBackend {
  /** Arm timers (and catch up overdue occurrences). Idempotent. */
  start(): void
  /** Disarm timers (schedule data stays on disk). */
  stop(): void
}

/**
 * Longest single timer we arm. setTimeout clamps past ~24.8 days (2^31-1 ms) and
 * fires immediately, so a far-out schedule is reached by chaining shorter waits.
 */
const MAX_TIMER_MS = 12 * 60 * 60 * 1000

export function createSchedulerService(deps: SchedulerServiceDeps): SchedulerService {
  const now = deps.now ?? Date.now
  const warn = deps.warn ?? ((m: string) => log.warn(m))

  let schedules: ScheduledRunInfo[] = load()
  let timer: NodeJS.Timeout | null = null
  let started = false

  function load(): ScheduledRunInfo[] {
    let raw: string
    try {
      raw = readFileSync(deps.file, 'utf8')
    } catch {
      return [] // first run — no store yet
    }
    try {
      const parsed = JSON.parse(raw) as PersistedSchedules
      if (!Array.isArray(parsed.schedules)) return []
      return parsed.schedules
    } catch {
      // A corrupt store must not take scheduling down (or be silently clobbered):
      // set it aside for inspection and start empty, like the conversation store.
      warn(`schedules store unreadable — moving it aside: ${deps.file}.corrupt`)
      try {
        renameSync(deps.file, `${deps.file}.corrupt`)
      } catch {
        // best effort — an unwritable directory will surface again on save()
      }
      return []
    }
  }

  function save(): void {
    const toWrite: PersistedSchedules = {
      schemaVersion: SCHEDULES_SCHEMA_VERSION,
      schedules
    }
    try {
      mkdirSync(dirname(deps.file), { recursive: true })
      // Atomic + private (0600): the prompt can contain project details.
      const tmp = `${deps.file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(toWrite, null, 2), { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, deps.file)
    } catch (e) {
      warn(`failed to persist schedules: ${String(e)}`)
    }
  }

  /** Parse a stored spec, tolerating nothing: a stored spec was validated at create. */
  function specOf(s: ScheduledRunInfo): ScheduleSpec | null {
    const parsed = parseScheduleSpec(s.spec)
    return typeof parsed === 'string' ? null : parsed
  }

  function arm(): void {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (!started) return
    const times = schedules
      .map((s) => s.nextRunAt)
      .filter((t): t is number => t !== null)
    if (times.length === 0) return
    const delay = Math.min(Math.max(Math.min(...times) - now(), 0), MAX_TIMER_MS)
    timer = setTimeout(fireDue, delay)
    // A pending timer must not hold the process open (the CLI exits when its
    // session ends; Electron quits on window close).
    timer.unref?.()
  }

  function fireDue(): void {
    timer = null
    const at = now()
    let fired = false
    for (const s of schedules) {
      if (s.nextRunAt === null || s.nextRunAt > at) continue
      fired = true
      const spec = specOf(s)
      // Advance BEFORE firing so a fire that throws synchronously can't wedge the
      // schedule into refiring the same occurrence forever.
      s.lastFiredAt = at
      s.nextRunAt = spec ? nextOccurrence(spec, new Date(at)) : null
      deps
        .fire(s)
        .then(() => {
          s.lastResult = 'ok'
          delete s.lastError
          save()
        })
        .catch((e: unknown) => {
          s.lastResult = 'error'
          s.lastError = e instanceof Error ? e.message : String(e)
          warn(`scheduled run "${s.name}" (${s.id}) failed to start: ${s.lastError}`)
          save()
        })
    }
    if (fired) {
      // Spent one-shots ('once' after firing) are removed rather than listed forever.
      schedules = schedules.filter((s) => s.nextRunAt !== null || s.lastFiredAt === undefined)
      save()
    }
    arm()
  }

  return {
    create(input: ScheduledRunInput): ScheduledRunInfo {
      const parsed = parseScheduleSpec(input.spec, new Date(now()))
      if (typeof parsed === 'string') throw new Error(parsed)
      const at = now()
      const info: ScheduledRunInfo = {
        ...input,
        // Normalized description so listings read consistently however it was typed.
        spec: describeSpec(parsed),
        id: `sch-${randomBytes(4).toString('hex')}`,
        nextRunAt: nextOccurrence(parsed, new Date(at)),
        createdAt: at
      }
      schedules.push(info)
      save()
      arm()
      return { ...info }
    },

    list(): ScheduledRunInfo[] {
      return schedules.map((s) => ({ ...s }))
    },

    cancel(id: string): boolean {
      const before = schedules.length
      schedules = schedules.filter((s) => s.id !== id)
      if (schedules.length === before) return false
      save()
      arm()
      return true
    },

    start(): void {
      if (started) return
      started = true
      // Catch-up pass: anything due while we were down fires once now (fireDue
      // also recomputes each schedule's next occurrence from the present).
      fireDue()
    },

    stop(): void {
      started = false
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    }
  }
}

/**
 * The production `fire`: start the occurrence as a background session through
 * the spawn seam — the same path `spawn_session` takes, so fired runs get the
 * live-session concurrency cap and show up as ordinary conversations. Kept here
 * (not inlined per host) so the desktop and terminal hosts can't drift.
 */
export function fireViaSpawn(): (s: ScheduledRunInfo) => Promise<void> {
  return async (s) => {
    if (!isSpawnBackendConfigured()) {
      throw new Error('no spawn backend wired — cannot start the scheduled session')
    }
    await spawnSession({
      title: s.name,
      prompt: s.prompt,
      providerId: s.providerId,
      model: s.model,
      approvalPolicy: s.approvalPolicy,
      workspace: s.workspace
    })
  }
}
