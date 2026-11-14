import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  parseScheduleSpec,
  nextOccurrence,
  describeSpec,
  type ScheduleSpec
} from './agent/schedule-spec'
import {
  MAX_SCHEDULE_ERROR_CHARS,
  type SchedulerBackend,
  type ScheduledFire,
  type ScheduledRunInfo,
  type ScheduledRunInput,
  type ScheduledRunResult
} from './agent/scheduler'
import type { RunOutcome } from '@shared/runEnd'
import { spawnSession, isSpawnBackendConfigured } from './agent/spawn'
import { isApprovalPolicy } from '@shared/types'
import { isReasoningEffort } from '@shared/agent'
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
 * The file is the source of truth, not any one process's copy of it. The desktop app
 * and a terminal session can run at once, and either can create or cancel a schedule
 * (the one-shot CLI only manages them). So every change re-reads the file, applies
 * itself, and writes it back under a lock file, and a firing host advances a due
 * schedule on disk BEFORE starting its run, so a second host that wakes for the same
 * occurrence sees it already taken. Hosts re-read the file at least every
 * {@link POLL_MS}, so a schedule created in another process fires on time.
 *
 * Everything host-specific is injected: hosts that only manage schedules (the
 * one-shot headless CLI) create the service and never `start()` it, so creating/
 * listing/cancelling works everywhere while timers only run in long-lived hosts.
 */

/**
 * Persisted shape. Bump + migrate in load() when the schema changes.
 *
 * 2: `lastResult` is how the fired run ENDED (with `running` while it is in flight),
 * not just whether its session started. A version 1 `ok` only meant "started", so
 * migrating drops it rather than claim the run finished.
 */
const SCHEDULES_SCHEMA_VERSION = 2

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
  /**
   * Start one occurrence's background session. Rejections mark the schedule's
   * lastResult as an error; a returned {@link ScheduledFire} marks it running until
   * its `ended` settles with how the run went. Resolving with nothing means the fire
   * did all its work, and records it as finished.
   */
  fire: (schedule: ScheduledRunInfo) => Promise<ScheduledFire | void>
  /** Clock, injectable for tests. */
  now?: () => number
  warn?: (message: string) => void
  /**
   * How many times to try for the store's lock before going ahead without it
   * (default LOCK_ATTEMPTS). Tests that hold the lock on purpose shorten the wait.
   */
  lockAttempts?: number
}

export interface SchedulerService extends SchedulerBackend {
  /**
   * Pause or resume a schedule. A paused one keeps its place in the store but never
   * fires (nor catches up); resuming takes its next occurrence from now, so the
   * occurrences missed while paused don't all fire at once. Null for an unknown id.
   */
  setPaused(id: string, paused: boolean): ScheduledRunInfo | null
  /**
   * Fire one occurrence now, outside the schedule (its next planned run is
   * unchanged). Resolves once the session has started; rejects when the id is
   * unknown or the session can't start, recording that on the schedule.
   */
  runNow(id: string): Promise<void>
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

/**
 * Longest a running host goes without re-reading the store, so a schedule another
 * process created (the desktop app and a terminal session share the file) is picked
 * up within a minute of when it is due. Well under the 5-minute minimum interval.
 */
export const POLL_MS = 60 * 1000

/** Attempts to take the store's lock file before going ahead without it. */
const LOCK_ATTEMPTS = 200
/** Pause between lock attempts. The critical section is a few synchronous file ops. */
const LOCK_RETRY_MS = 5

/**
 * Age past which a lock file is abandoned whoever it names. The critical section is a
 * few synchronous file ops, so no live holder keeps it this long; but a pid check
 * alone never breaks a lock whose pid was reused after its holder crashed.
 */
export const LOCK_STALE_MS = 30 * 1000

/** The message a run left running by a host that has since quit is settled with. */
export const ORPHANED_RUN_MESSAGE = 'Houston closed before this run finished.'

/** Whether a process with this pid exists (EPERM: it does, owned by someone else). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** A failure message as the store keeps it: one line, bounded. */
function boundedError(message: string): string {
  const flat = message.replace(/\s+/g, ' ').trim() || 'The run failed.'
  return flat.length > MAX_SCHEDULE_ERROR_CHARS ? `${flat.slice(0, MAX_SCHEDULE_ERROR_CHARS - 1)}…` : flat
}

/** What a fire's outcome writes onto its schedule. */
interface RunRecord {
  lastResult: ScheduledRunResult
  lastError?: string
  lastLimit?: RunOutcome['limit']
}

function recordOf(o: RunOutcome): RunRecord {
  switch (o.outcome) {
    case 'done':
      return { lastResult: 'ok' }
    case 'error':
      return { lastResult: 'error', lastError: boundedError(o.message ?? 'The run failed.') }
    case 'limit':
      return { lastResult: 'limit', lastLimit: o.limit ?? 'max-steps' }
    case 'stopped':
      return { lastResult: 'stopped' }
  }
}

/** Write a run record onto a schedule, clearing what the previous run left. */
function applyRecord(s: ScheduledRunInfo, r: RunRecord): void {
  s.lastResult = r.lastResult
  if (r.lastError === undefined) delete s.lastError
  else s.lastError = r.lastError
  if (r.lastLimit === undefined) delete s.lastLimit
  else s.lastLimit = r.lastLimit
  // The pid only matters while a run is in flight.
  if (r.lastResult !== 'running') delete s.lastRunPid
}

/**
 * Whether a schedule says its run is in flight in a process that no longer exists,
 * so nothing will ever record how it ended. A run in this process is left alone:
 * this process is alive, and records its own runs' ends.
 */
function isOrphanedRun(s: ScheduledRunInfo): boolean {
  if (s.lastResult !== 'running') return false
  if (typeof s.lastRunPid !== 'number' || !Number.isInteger(s.lastRunPid) || s.lastRunPid <= 0) return true
  if (s.lastRunPid === process.pid) return false
  return !pidAlive(s.lastRunPid)
}

/** Block this thread for `ms` (the lock is taken from synchronous code). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Whether a lock file was abandoned: it is older than {@link LOCK_STALE_MS}, or it
 * names a process that no longer exists (it died holding it).
 */
function lockIsStale(lock: string): boolean {
  let pid: number
  try {
    if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) return true
    pid = Number(readFileSync(lock, 'utf8').trim())
  } catch {
    return false // gone already, or unreadable: let the next attempt find out
  }
  if (!Number.isInteger(pid) || pid <= 0) return false // still being written
  try {
    process.kill(pid, 0)
    return false
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

export function createSchedulerService(deps: SchedulerServiceDeps): SchedulerService {
  const now = deps.now ?? Date.now
  const warn = deps.warn ?? ((m: string) => log.warn(m))

  // The version the store was read at. A newer Houston may have written it (the user
  // downgraded); saving keeps that higher number so a later upgrade doesn't re-run
  // migrations the file has already been through.
  let storedVersion = SCHEDULES_SCHEMA_VERSION
  // Identity of the store as of the last read (see stampOf), or null once the
  // in-memory copy has been changed here, so the next poll reads it again.
  let lastStamp: string | null = null
  let schedules: ScheduledRunInfo[] = load()
  let timer: NodeJS.Timeout | null = null
  let started = false

  /**
   * Run `fn` holding `<file>.lock`, so two processes' read-modify-write of the store
   * can't interleave. A lock left by a process that died is broken; one that stays
   * held past the retry budget is waited out no longer (a lost update beats a host
   * that can never change its schedules).
   */
  function locked<T>(fn: () => T): T {
    const lock = `${deps.file}.lock`
    let held = false
    for (let attempt = 0; attempt < (deps.lockAttempts ?? LOCK_ATTEMPTS) && !held; attempt++) {
      try {
        mkdirSync(dirname(deps.file), { recursive: true })
        writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 })
        held = true
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') break // can't lock here at all
        if (lockIsStale(lock)) {
          try {
            unlinkSync(lock)
          } catch {
            // another process broke it first
          }
          continue
        }
        sleepSync(LOCK_RETRY_MS)
      }
    }
    if (!held) warn(`could not lock ${deps.file}; updating schedules without the lock`)
    try {
      return fn()
    } finally {
      if (held) {
        try {
          unlinkSync(lock)
        } catch {
          // already gone
        }
      }
    }
  }

  /** Replace the in-memory copy with what is on disk now. */
  function reload(): void {
    schedules = load()
  }

  /**
   * The store's inode, size and mtime, or 'missing'. Every save writes a new file
   * and renames it into place, so any change, from any process, changes the inode.
   */
  function stampOf(): string {
    try {
      const st = statSync(deps.file)
      return `${st.ino}:${st.size}:${st.mtimeMs}`
    } catch {
      return 'missing'
    }
  }

  function load(): ScheduledRunInfo[] {
    // Taken before the read: a write landing in between makes the next poll read
    // again, never skip a change.
    lastStamp = stampOf()
    let raw: string
    try {
      raw = readFileSync(deps.file, 'utf8')
    } catch {
      return [] // first run — no store yet
    }
    try {
      const parsed = JSON.parse(raw) as PersistedSchedules
      const version = typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : 1
      storedVersion = Math.max(SCHEDULES_SCHEMA_VERSION, version)
      if (!Array.isArray(parsed.schedules)) return []
      if (version < 2) {
        // v1 -> v2: a v1 'ok' meant the session started, not that the run finished.
        for (const s of parsed.schedules) if (s && s.lastResult === 'ok') delete s.lastResult
      }
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
    // The in-memory copy now differs from what was read (and from disk, if this
    // write fails), so the next poll must not take the store as unchanged.
    lastStamp = null
    const toWrite: PersistedSchedules = {
      schemaVersion: storedVersion,
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
      .filter((s) => !s.paused)
      .map((s) => s.nextRunAt)
      .filter((t): t is number => t !== null)
    // Wake at the earliest known occurrence, and at least every POLL_MS regardless, to
    // pick up schedules another process added since the last read.
    const earliest = times.length ? Math.max(Math.min(...times) - now(), 0) : POLL_MS
    const delay = Math.min(earliest, POLL_MS, MAX_TIMER_MS)
    timer = setTimeout(fireDue, delay)
    // A pending timer must not hold the process open (the CLI exits when its
    // session ends; Electron quits on window close).
    timer.unref?.()
  }

  function fireDue(): void {
    timer = null
    const at = now()
    // An idle poll: nothing in memory is due and the store is the one last read, so a
    // reload under the lock would find nothing to claim. Skip the lock file and the
    // read until the store changes (another process edited it) or an occurrence
    // comes due.
    if (
      lastStamp !== null &&
      !schedules.some((s) => s.nextRunAt !== null && s.nextRunAt <= at) &&
      stampOf() === lastStamp
    ) {
      arm()
      return
    }
    // Claim every due occurrence on disk before starting any run, so another host
    // waking for the same occurrence finds it already advanced.
    const due = locked(() => {
      reload()
      const claimed: ScheduledRunInfo[] = []
      for (const s of schedules) {
        if (s.paused || s.nextRunAt === null || s.nextRunAt > at) continue
        const spec = specOf(s)
        // Advance BEFORE firing so a fire that throws synchronously can't wedge the
        // schedule into refiring the same occurrence forever.
        s.lastFiredAt = at
        // A 'once' is spent after this fire. Re-deriving it would re-read its local-time
        // spec in the current zone, which after a time-zone change can name a later
        // instant and fire it a second time.
        s.nextRunAt = spec && spec.kind !== 'once' ? nextOccurrence(spec, new Date(at)) : null
        claimed.push({ ...s })
      }
      if (claimed.length > 0) {
        // Spent one-shots ('once' after firing) are removed rather than listed forever.
        schedules = schedules.filter((s) => s.nextRunAt !== null || s.lastFiredAt === undefined)
        save()
      }
      return claimed
    })
    for (const s of due) {
      deps.fire(s).then(
        (started) => recordStarted(s.id, started),
        (e: unknown) => {
          const lastError = e instanceof Error ? e.message : String(e)
          warn(`scheduled run "${s.name}" (${s.id}) failed to start: ${lastError}`)
          recordStartFailed(s.id, lastError)
        }
      )
    }
    arm()
  }

  /** Change a schedule as it is on disk now (it may be gone, or changed by another process). */
  function update(id: string, fn: (s: ScheduledRunInfo) => boolean | void): void {
    locked(() => {
      reload()
      const s = schedules.find((x) => x.id === id)
      if (!s || fn(s) === false) return
      save()
    })
  }

  /** A fire could not start its session. */
  function recordStartFailed(id: string, message: string): void {
    update(id, (s) => {
      applyRecord(s, { lastResult: 'error', lastError: boundedError(message) })
      delete s.lastRunConversationId
    })
  }

  /**
   * A fire started its session: mark it running, then record how it ends. A void
   * fire did all its work already.
   */
  function recordStarted(id: string, handle: ScheduledFire | void): void {
    if (!handle) {
      update(id, (s) => {
        applyRecord(s, { lastResult: 'ok' })
        delete s.lastRunConversationId
      })
      return
    }
    const { conversationId } = handle
    update(id, (s) => {
      applyRecord(s, { lastResult: 'running' })
      s.lastRunConversationId = conversationId
      s.lastRunPid = process.pid
    })
    handle.ended.then(
      (outcome) => recordEnded(id, conversationId, recordOf(outcome)),
      (e: unknown) =>
        recordEnded(id, conversationId, {
          lastResult: 'error',
          lastError: boundedError(e instanceof Error ? e.message : String(e))
        })
    )
  }

  /** The run a fire started ended. Ignored once a later fire of the schedule has started. */
  function recordEnded(id: string, conversationId: string, r: RunRecord): void {
    update(id, (s) => {
      if (s.lastRunConversationId !== conversationId) return false
      applyRecord(s, r)
    })
  }

  /**
   * Settle every run left 'running' by a process that has quit (the app was closed or
   * crashed mid-run), so a schedule never shows a run in flight forever.
   */
  function settleOrphanedRuns(): void {
    if (!schedules.some(isOrphanedRun)) return
    locked(() => {
      reload()
      const orphans = schedules.filter(isOrphanedRun)
      if (orphans.length === 0) return
      for (const s of orphans) applyRecord(s, { lastResult: 'error', lastError: ORPHANED_RUN_MESSAGE })
      save()
    })
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
      locked(() => {
        reload()
        schedules.push(info)
        save()
      })
      arm()
      return { ...info }
    },

    list(): ScheduledRunInfo[] {
      reload()
      settleOrphanedRuns()
      return schedules.map((s) => ({ ...s }))
    },

    cancel(id: string): boolean {
      const removed = locked(() => {
        reload()
        const before = schedules.length
        schedules = schedules.filter((s) => s.id !== id)
        if (schedules.length === before) return false
        save()
        return true
      })
      if (removed) arm()
      return removed
    },

    setPaused(id: string, paused: boolean): ScheduledRunInfo | null {
      const updated = locked(() => {
        reload()
        const s = schedules.find((x) => x.id === id)
        if (!s) return null
        if (paused) {
          s.paused = true
        } else if (s.paused) {
          delete s.paused
          // Pick up from now: what came due while paused is skipped, not fired in a burst.
          const spec = specOf(s)
          const at = now()
          if (spec && s.nextRunAt !== null && s.nextRunAt <= at) s.nextRunAt = nextOccurrence(spec, new Date(at))
        }
        save()
        return { ...s }
      })
      if (updated) arm()
      return updated
    },

    async runNow(id: string): Promise<void> {
      const target = locked(() => {
        reload()
        const s = schedules.find((x) => x.id === id)
        if (!s) return null
        s.lastFiredAt = now()
        save()
        return { ...s }
      })
      if (!target) throw new Error('That scheduled run no longer exists.')
      let fired: ScheduledFire | void
      try {
        fired = await deps.fire(target)
      } catch (e) {
        const lastError = e instanceof Error ? e.message : String(e)
        recordStartFailed(id, lastError)
        throw new Error(lastError, { cause: e })
      }
      recordStarted(id, fired)
    },

    start(): void {
      if (started) return
      started = true
      // A run this host's previous life left in flight will never report its end.
      reload()
      settleOrphanedRuns()
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
export function fireViaSpawn(
  /** How a chat's latest run ended, from its log; undefined when the chat is gone. */
  outcomeOf: (conversationId: string) => RunOutcome | undefined
): (s: ScheduledRunInfo) => Promise<ScheduledFire> {
  return async (s) => {
    if (!isSpawnBackendConfigured()) {
      throw new Error('no spawn backend wired — cannot start the scheduled session')
    }
    let runEnded!: () => void
    const settled = new Promise<void>((resolve) => (runEnded = resolve))
    const result = await spawnSession({
      onRunEnd: () => runEnded(),
      title: s.name,
      prompt: s.prompt,
      providerId: s.providerId,
      model: s.model,
      // The store is a file on disk: an unknown policy would fail open downstream,
      // so coerce it to the most restrictive, and drop an unknown effort.
      approvalPolicy: isApprovalPolicy(s.approvalPolicy) ? s.approvalPolicy : 'plan',
      ...(isReasoningEffort(s.reasoningEffort) ? { reasoningEffort: s.reasoningEffort } : {}),
      workspace: s.workspace
    })
    const { conversationId } = result
    // A chat deleted mid-run had its run killed with it.
    const ended = settled.then((): RunOutcome => outcomeOf(conversationId) ?? { outcome: 'stopped' })
    return { conversationId, ended }
  }
}
