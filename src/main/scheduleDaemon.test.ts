import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PID_HEARTBEAT_MS,
  PID_STALE_MS,
  appSchedulerPidPath,
  appSchedulerRunning,
  daemonPidPath,
  holdPidFile,
  livePid,
  runningDaemonPid
} from './scheduleDaemon'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'houston-daemon-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** Pids 100 and 200 are alive; everything else is not. */
const alive = (pid: number): boolean => pid === 100 || pid === 200

describe('pid files', () => {
  it('holds a free pid file and releases only its own', () => {
    const path = daemonPidPath(dir)
    const held = holdPidFile(path, 100, alive)
    expect(held.ok).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('100')
    expect(livePid(path, alive)).toBe(100)
    // Another live process can't take it.
    expect(holdPidFile(path, 200, alive)).toEqual({ ok: false, pid: 100 })
    // A release after someone else took over leaves their file alone.
    writeFileSync(path, '200')
    if (held.ok) held.release()
    expect(readFileSync(path, 'utf8')).toBe('200')
  })

  it('takes over a file left by a process that died', () => {
    const path = daemonPidPath(dir)
    writeFileSync(path, '999')
    const held = holdPidFile(path, 100, alive)
    expect(held.ok).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('100')
    if (held.ok) held.release()
    expect(existsSync(path)).toBe(false)
  })

  it('reads a missing, malformed, or dead pid as nobody', () => {
    const path = daemonPidPath(dir)
    expect(livePid(path, alive)).toBeNull()
    writeFileSync(path, 'not a pid')
    expect(livePid(path, alive)).toBeNull()
    writeFileSync(path, '-5')
    expect(livePid(path, alive)).toBeNull()
    writeFileSync(path, '999')
    expect(livePid(path, alive)).toBeNull()
    expect(runningDaemonPid(dir, alive)).toBeNull()
    writeFileSync(path, '200\n')
    expect(runningDaemonPid(dir, alive)).toBe(200)
  })

  it("tells whether the desktop app's scheduler is running", () => {
    expect(appSchedulerRunning(dir, alive)).toBe(false)
    writeFileSync(appSchedulerPidPath(dir), '999')
    expect(appSchedulerRunning(dir, alive)).toBe(false)
    writeFileSync(appSchedulerPidPath(dir), '100')
    expect(appSchedulerRunning(dir, alive)).toBe(true)
  })

  it('reads a file its holder stopped refreshing as nobody, whatever live pid it names', () => {
    const later = (): number => Date.now() + PID_STALE_MS + 1000
    // A file left behind (crash, force quit, reboot) naming a pid that now belongs to
    // some other live process.
    writeFileSync(appSchedulerPidPath(dir), '100')
    writeFileSync(daemonPidPath(dir), '200')
    expect(appSchedulerRunning(dir, alive)).toBe(true)
    expect(appSchedulerRunning(dir, alive, later)).toBe(false)
    expect(runningDaemonPid(dir, alive, later)).toBeNull()
    // So the daemon can start and the app can take its marker back.
    const daemon = holdPidFile(daemonPidPath(dir), 300, alive, later)
    expect(daemon.ok).toBe(true)
    expect(readFileSync(daemonPidPath(dir), 'utf8')).toBe('300')
    const app = holdPidFile(appSchedulerPidPath(dir), 300, alive, later)
    expect(app.ok).toBe(true)
    if (daemon.ok) daemon.release()
    if (app.ok) app.release()
  })

  it('keeps a held file fresh while its holder runs, and stops once released', () => {
    vi.useFakeTimers()
    try {
      const path = daemonPidPath(dir)
      const start = Date.now()
      const held = holdPidFile(path, 100, alive)
      expect(held.ok).toBe(true)
      // Backdate the file as if it were written long ago; the next heartbeat refreshes it.
      const old = new Date(start - PID_STALE_MS * 2)
      utimesSync(path, old, old)
      expect(livePid(path, alive)).toBeNull()
      vi.advanceTimersByTime(PID_HEARTBEAT_MS)
      expect(livePid(path, alive)).toBe(100)
      // Another process took it over: the old holder leaves it alone.
      writeFileSync(path, '200')
      utimesSync(path, old, old)
      vi.advanceTimersByTime(PID_HEARTBEAT_MS)
      expect(statSync(path).mtimeMs).toBe(old.getTime())
      if (held.ok) held.release()
      expect(readFileSync(path, 'utf8')).toBe('200')
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats this real process as alive', () => {
    const held = holdPidFile(daemonPidPath(dir))
    expect(held.ok).toBe(true)
    expect(runningDaemonPid(dir)).toBe(process.pid)
    if (held.ok) held.release()
  })
})
