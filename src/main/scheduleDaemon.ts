import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getUserDataDir } from './userData'

/**
 * The schedule daemon's process bookkeeping: a pid file so only one daemon runs per
 * profile, and a marker the desktop app writes while its own scheduler runs, so the
 * daemon leaves firing to the app while it is open.
 *
 * Two hosts can't fire the same occurrence either way: the scheduler claims a due
 * occurrence on disk, under the store's lock, before starting it (see
 * schedulerService.ts). The marker is about where a run lands: one the app fires is
 * an ordinary chat that can ask for approvals in its window, while one the daemon
 * fires runs unattended and declines them. So the app goes first whenever it is up.
 *
 * Electron-free: the standalone CLI's `houston schedule-daemon` and the desktop
 * binary's `--schedule-daemon` mode share it.
 */

/** Where the running daemon records its pid. */
export function daemonPidPath(dir: string = getUserDataDir()): string {
  return join(dir, 'schedule-daemon.pid')
}

/** Where the desktop app records its pid while its scheduler runs. */
export function appSchedulerPidPath(dir: string = getUserDataDir()): string {
  return join(dir, 'scheduler-app.pid')
}

/** Whether a process with this pid exists (EPERM: it does, owned by someone else). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** The live process a pid file names, or null when it is missing, malformed, or dead. */
export function livePid(path: string, alive: (pid: number) => boolean = pidAlive): number | null {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const pid = Number(text.trim())
  return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : null
}

/**
 * Record `pid` in `path` for as long as this process holds it. Refused (with the
 * holder's pid) while another live process holds it; a file left by a process that
 * has died is taken over. Returns the release, which removes the file only if it
 * still names this process.
 */
export function holdPidFile(
  path: string,
  pid: number = process.pid,
  alive: (pid: number) => boolean = pidAlive
): { ok: true; release: () => void } | { ok: false; pid: number } {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, String(pid), { flag: 'wx', mode: 0o600 })
      return {
        ok: true,
        release: () => {
          try {
            if (readFileSync(path, 'utf8').trim() === String(pid)) unlinkSync(path)
          } catch {
            // Already gone.
          }
        }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      const holder = livePid(path, alive)
      if (holder !== null && holder !== pid) return { ok: false, pid: holder }
      // Stale (or our own, from a reused pid): take it over.
      try {
        unlinkSync(path)
      } catch {
        // Another process took it over first; the next attempt sees theirs.
      }
    }
  }
  const holder = livePid(path, alive)
  return { ok: false, pid: holder ?? 0 }
}

/** Whether the desktop app's scheduler is running (so the daemon should not fire). */
export function appSchedulerRunning(dir?: string, alive?: (pid: number) => boolean): boolean {
  return livePid(appSchedulerPidPath(dir), alive) !== null
}

/** The running daemon's pid, or null. */
export function runningDaemonPid(dir?: string, alive?: (pid: number) => boolean): number | null {
  return livePid(daemonPidPath(dir), alive)
}
