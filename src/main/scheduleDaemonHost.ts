import { existsSync } from 'node:fs'
import { join, win32 } from 'node:path'
import type { ipcMain } from 'electron'
import { IPC } from '@shared/constants'
import type { ScheduleDaemonStatus } from '@shared/schedules'
import {
  disableScheduleDaemon,
  installLoginAgent,
  loginAgentMatches,
  scheduleDaemonState,
  type DaemonCommand,
  type LoginAgentDeps
} from './loginAgent'
import { appSchedulerPidPath, holdPidFile, runningDaemonPid } from './scheduleDaemon'
import { log } from './logger'

/**
 * The desktop app's side of "Run scheduled runs when Houston is closed": what the
 * login agent starts (this app's own executable in `--schedule-daemon` mode, so the
 * daemon reads keys from the app's credential store), the Settings toggle that
 * installs or removes it, the startup check that keeps it pointing at the current
 * executable, and the marker that tells a daemon the app is open and firing itself.
 */

export interface AppExecutable {
  execPath: string
  isPackaged: boolean
  /** The app's code path (unpackaged dev runs start Electron with it). */
  appPath: string
  platform: NodeJS.Platform
  /** The AppImage's own path on Linux, which stays put while execPath is a mount. */
  appImage?: string
  exists?: (p: string) => boolean
}

/**
 * The daemon command for this app. A packaged build starts its own binary; on Linux
 * an AppImage starts the image file (its mount point changes every launch); on Windows
 * the install's top-level launcher, which survives updates that replace the versioned
 * app folder. A dev run starts Electron with the app's path.
 */
export function appDaemonCommand(exe: AppExecutable, userData: string): DaemonCommand {
  const exists = exe.exists ?? existsSync
  let program = exe.execPath
  if (exe.isPackaged && exe.platform === 'linux' && exe.appImage) program = exe.appImage
  if (exe.isPackaged && exe.platform === 'win32') {
    // <install>\app-1.2.3\Houston.exe -> <install>\Houston.exe (the updater's stub).
    const versioned = win32.dirname(exe.execPath)
    const stub = win32.join(win32.dirname(versioned), win32.basename(exe.execPath))
    if (/^app-\d/i.test(win32.basename(versioned)) && exists(stub)) program = stub
  }
  return {
    program,
    args: [...(exe.isPackaged ? [] : [exe.appPath]), '--schedule-daemon'],
    logFile: join(userData, 'schedule-daemon.out.log')
  }
}

export interface ScheduleDaemonHostDeps {
  command: () => DaemonCommand
  login: LoginAgentDeps
  runningPid?: () => number | null
}

async function status(deps: ScheduleDaemonHostDeps, error?: string): Promise<ScheduleDaemonStatus> {
  const s = await scheduleDaemonState(deps.login, deps.runningPid ?? (() => runningDaemonPid()))
  return {
    supported: s.supported,
    installed: s.installed,
    running: s.pid !== null,
    ...(error ? { error } : {})
  }
}

/** Turn the daemon on or off from Settings (install or remove the login agent). */
export async function setScheduleDaemon(on: boolean, deps: ScheduleDaemonHostDeps): Promise<ScheduleDaemonStatus> {
  const runningPid = deps.runningPid ?? (() => runningDaemonPid())
  if (on) {
    const r = await installLoginAgent(deps.command(), deps.login)
    if (!r.ok) {
      log.warn(`schedule daemon: install failed: ${r.error}`)
      return status(deps, r.error)
    }
    log.info('schedule daemon: login agent installed')
    return status(deps)
  }
  const r = await disableScheduleDaemon(deps.login, runningPid)
  if (!r.ok) {
    log.warn(`schedule daemon: removal failed: ${r.error}`)
    return status(deps, r.error)
  }
  log.info('schedule daemon: login agent removed')
  return status(deps)
}

/**
 * At startup, when the app's login agent is installed: reinstall it if it starts
 * something else (an update moved the executable). An agent `houston schedule-daemon
 * install` set up is the terminal's (its own keys and profile), so it is left alone.
 * Best effort: a failure is logged.
 */
export async function ensureScheduleDaemon(deps: ScheduleDaemonHostDeps): Promise<void> {
  const state = await scheduleDaemonState(deps.login, () => null)
  if (!state.installed) return
  if (!state.byApp) {
    log.info('schedule daemon: the login agent starts the terminal daemon; leaving it as it is')
    return
  }
  const cmd = deps.command()
  if (await loginAgentMatches(cmd, deps.login)) return
  const r = await installLoginAgent(cmd, deps.login)
  if (r.ok) log.info('schedule daemon: login agent updated to this executable')
  else log.warn(`schedule daemon: couldn't update the login agent: ${r.error}`)
}

/** Settings > Scheduled runs: read and change the daemon setting. */
export function registerScheduleDaemonIpc(handle: typeof ipcMain.handle, deps: ScheduleDaemonHostDeps): void {
  handle(IPC.schedulesDaemonGet, (): Promise<ScheduleDaemonStatus> => status(deps))
  handle(IPC.schedulesDaemonSet, (_e, on: unknown): Promise<ScheduleDaemonStatus> =>
    typeof on === 'boolean' ? setScheduleDaemon(on, deps) : status(deps, 'Expected on or off.')
  )
}

/**
 * Mark the app as the host firing scheduled runs, for as long as it runs, so a daemon
 * leaves them to it. Returns the release (call it at quit); a no-op when another live
 * app process holds the marker.
 */
export function markAppScheduler(): () => void {
  try {
    const held = holdPidFile(appSchedulerPidPath())
    return held.ok ? held.release : () => {}
  } catch (e) {
    log.warn(`schedule daemon: couldn't write the app marker: ${(e as Error).message}`)
    return () => {}
  }
}
