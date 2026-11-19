import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomicStampedSync } from './atomic-write'
import { log } from './logger'
import { getUserDataDir } from './userData'

/**
 * Which chats this process is running a turn in, on disk, so another Houston process
 * on the same profile (the desktop app, a terminal session, the schedule daemon) can
 * refuse to start a second run on one. Each process's own run guard is a map in
 * memory; without this, a chat the daemon is still running shows idle in the app,
 * and a send there starts a second run whose saves overwrite the first's.
 *
 * `<profile>/runs/<pid>.json` holds `{ pid, conversations }`. It is rewritten whenever
 * the set of running chats changes and every {@link RUN_MARKER_HEARTBEAT_MS} while it
 * is not empty, and removed once no run is left and at exit. A file counts only while
 * its process is alive and it was refreshed within {@link RUN_MARKER_STALE_MS}: a
 * crash leaves one behind, and its pid may since belong to an unrelated process.
 */

export const RUN_MARKER_HEARTBEAT_MS = 10_000
export const RUN_MARKER_STALE_MS = 3 * RUN_MARKER_HEARTBEAT_MS

let running: string[] = []
let heartbeat: ReturnType<typeof setInterval> | undefined
/** Where this process's marker was last written (the profile can change in tests). */
let written: string | null = null
let exitArmed = false
let warned = false

function markerDir(): string {
  return join(getUserDataDir(), 'runs')
}

function removeMarker(): void {
  if (written === null) return
  try {
    rmSync(written, { force: true })
  } catch {
    // Best effort: a marker left behind goes stale on its own.
  }
  written = null
}

function writeMarker(): void {
  if (running.length === 0) {
    removeMarker()
    return
  }
  try {
    const dir = markerDir()
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const path = join(dir, `${process.pid}.json`)
    if (written !== null && written !== path) removeMarker()
    writeFileAtomicStampedSync(path, JSON.stringify({ pid: process.pid, conversations: running }), 0o600, {
      durable: false
    })
    written = path
    if (!exitArmed) {
      exitArmed = true
      process.once('exit', removeMarker)
    }
  } catch (e) {
    // No profile yet, or a disk error: the in-process guard still holds. Logged once,
    // not on every heartbeat.
    if (!warned) log.warn(`could not record the running chats: ${(e as Error)?.message ?? String(e)}`)
    warned = true
  }
}

/** Record the chats this process is running now (every change to the set). */
export function recordRunningConversations(ids: readonly string[]): void {
  running = [...ids]
  writeMarker()
  if (running.length > 0 && !heartbeat) {
    heartbeat = setInterval(writeMarker, RUN_MARKER_HEARTBEAT_MS)
    heartbeat.unref?.()
  } else if (running.length === 0 && heartbeat) {
    clearInterval(heartbeat)
    heartbeat = undefined
  }
}

/** Whether this process is running a turn in `conversationId` now. */
export function conversationRunningHere(conversationId: string): boolean {
  return running.includes(conversationId)
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM: alive, owned by someone else.
    return (e as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

/**
 * The pid of another live Houston process running a turn in `conversationId`, or null.
 * Never throws: anything it can't read counts as no run.
 */
export function conversationRunningElsewhere(conversationId: string, now: number = Date.now()): number | null {
  let dir: string
  let names: string[]
  try {
    dir = markerDir()
    names = readdirSync(dir)
  } catch {
    return null
  }
  for (const name of names) {
    const m = /^(\d+)\.json$/.exec(name)
    if (!m) continue
    const pid = Number(m[1])
    if (pid === process.pid) continue
    const path = join(dir, name)
    try {
      if (now - statSync(path).mtimeMs > RUN_MARKER_STALE_MS || !alive(pid)) continue
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { conversations?: unknown }
      if (Array.isArray(raw.conversations) && raw.conversations.includes(conversationId)) return pid
    } catch {
      // Gone, or mid-replace: not a run this check can see.
    }
  }
  return null
}

/** What a client is told when it tries to run a chat another process is running. */
export const RUNNING_ELSEWHERE_MESSAGE =
  'This conversation has a run in progress in another Houston session (a terminal session or a scheduled run). Send again once it finishes.'

/** For tests: forget this process's marker state. */
export function resetRunMarkers(): void {
  if (heartbeat) clearInterval(heartbeat)
  heartbeat = undefined
  running = []
  removeMarker()
}
