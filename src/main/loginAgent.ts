import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * The per-user login agent that keeps the schedule daemon running while Houston is
 * closed, so scheduled runs fire on time instead of at the next launch.
 *
 * One entry per platform, installed for the current user only (never system-wide, no
 * elevation): a LaunchAgent on macOS, a systemd user unit on Linux, a Task Scheduler
 * task that runs at logon on Windows. Each starts `program` with `args` (the Houston
 * executable in daemon mode) and is started right away when installed. Uninstall stops
 * it and removes the entry. Nothing here runs a shell: every command is execFile with
 * literal arguments, and the file contents escape every value they embed.
 *
 * The OS seams (files, commands, the home folder) are injected so the plans can be
 * tested on any platform without touching the real login items.
 */

/** The LaunchAgent label and the systemd unit / Windows task names. */
export const LOGIN_AGENT_LABEL = 'ai.houstoncode.houston.schedule-daemon'
export const SYSTEMD_UNIT = 'houston-schedule-daemon.service'
export const WINDOWS_TASK = 'Houston schedule daemon'

/** What the agent starts. */
export interface DaemonCommand {
  program: string
  args: string[]
  /** Extra environment (HOUSTON_DATA_DIR when the profile was moved). */
  env?: Record<string, string>
  /** Where the daemon's own output goes (macOS and Linux keep it; Windows has its log file). */
  logFile?: string
}

export interface LoginAgentDeps {
  platform: NodeJS.Platform
  home: string
  /** The numeric user id, for launchctl's gui/<uid> domain (macOS). */
  uid?: number
  /** Run a program with literal arguments (no shell); never rejects. */
  exec: (file: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>
  writeFile: (path: string, content: string) => void
  readFile: (path: string) => string | null
  removeFile: (path: string) => void
}

export type LoginAgentResult = { ok: true } | { ok: false; error: string }

/** Escape text for an XML (plist) string element. */
function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** The LaunchAgent plist (macOS). */
export function launchAgentPlist(cmd: DaemonCommand): string {
  const args = [cmd.program, ...cmd.args].map((a) => `    <string>${xml(a)}</string>`).join('\n')
  const env = Object.entries(cmd.env ?? {})
  const envBlock = env.length
    ? `  <key>EnvironmentVariables</key>\n  <dict>\n${env
        .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
        .join('\n')}\n  </dict>\n`
    : ''
  const log = cmd.logFile
    ? `  <key>StandardOutPath</key>\n  <string>${xml(cmd.logFile)}</string>\n  <key>StandardErrorPath</key>\n  <string>${xml(cmd.logFile)}</string>\n`
    : ''
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LOGIN_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
${envBlock}  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
${log}</dict>
</plist>
`
}

/**
 * One systemd word: quoted, with backslash, quote and `%` (a specifier) escaped, and a
 * `$` doubled so it is never read as a variable.
 */
function systemdWord(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`
}

/** The systemd user unit (Linux). */
export function systemdUnit(cmd: DaemonCommand): string {
  const env = Object.entries(cmd.env ?? {}).map(([k, v]) => `Environment=${systemdWord(`${k}=${v}`)}\n`)
  return `[Unit]
Description=Houston scheduled runs
After=network-online.target

[Service]
Type=simple
ExecStart=${[cmd.program, ...cmd.args].map(systemdWord).join(' ')}
${env.join('')}Restart=on-failure
RestartSec=30
# Stopped by a signal (logout, systemctl stop): a clean exit, not a failure to restart from.
SuccessExitStatus=129 130 143

[Install]
WantedBy=default.target
`
}

/** Where each platform's entry lives (none on Windows: Task Scheduler keeps it). */
export function loginAgentPath(platform: NodeJS.Platform, home: string): string | null {
  if (platform === 'darwin') return join(home, 'Library', 'LaunchAgents', `${LOGIN_AGENT_LABEL}.plist`)
  if (platform === 'linux') return join(home, '.config', 'systemd', 'user', SYSTEMD_UNIT)
  return null
}

/**
 * One Windows command-line word for the task's /TR: quoted when it has a space, tab or
 * quote, with quotes and the backslashes before them escaped (the MS C runtime rules).
 */
function windowsWord(s: string): string {
  if (s && !/[\s"]/.test(s)) return s
  return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`
}

/** The Task Scheduler arguments that create the task (Windows). */
export function windowsTaskArgs(cmd: DaemonCommand): string[] {
  return [
    '/Create',
    '/F',
    '/SC',
    'ONLOGON',
    '/RL',
    'LIMITED',
    '/TN',
    WINDOWS_TASK,
    '/TR',
    [cmd.program, ...cmd.args].map(windowsWord).join(' ')
  ]
}

function failed(what: string, r: { code: number; stderr: string; stdout: string }): LoginAgentResult {
  const detail = (r.stderr || r.stdout).trim().split('\n')[0]?.trim()
  return { ok: false, error: `${what} failed${detail ? `: ${detail}` : ` (exit ${r.code})`}` }
}

/**
 * Install (or reinstall) the login agent and start it now. A failure leaves nothing
 * behind, so "installed" never describes an agent the OS refused.
 */
export async function installLoginAgent(cmd: DaemonCommand, deps: LoginAgentDeps): Promise<LoginAgentResult> {
  const path = loginAgentPath(deps.platform, deps.home)
  if (deps.platform === 'darwin') {
    if (deps.uid === undefined) return { ok: false, error: 'Unknown user id.' }
    const domain = `gui/${deps.uid}`
    deps.writeFile(path!, launchAgentPlist(cmd))
    // A previous copy is replaced: unload it first (it may not be loaded).
    await deps.exec('launchctl', ['bootout', `${domain}/${LOGIN_AGENT_LABEL}`])
    const r = await deps.exec('launchctl', ['bootstrap', domain, path!])
    if (r.code === 0) return { ok: true }
    deps.removeFile(path!)
    return failed('launchctl bootstrap', r)
  }
  if (deps.platform === 'linux') {
    deps.writeFile(path!, systemdUnit(cmd))
    const undo = async (): Promise<void> => {
      deps.removeFile(path!)
      await deps.exec('systemctl', ['--user', 'daemon-reload'])
    }
    const reload = await deps.exec('systemctl', ['--user', 'daemon-reload'])
    if (reload.code !== 0) {
      await undo()
      return failed('systemctl --user daemon-reload', reload)
    }
    const r = await deps.exec('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT])
    if (r.code !== 0) {
      await deps.exec('systemctl', ['--user', 'disable', SYSTEMD_UNIT])
      await undo()
      return failed('systemctl --user enable', r)
    }
    // A reinstall over a running copy must pick up the new command line.
    await deps.exec('systemctl', ['--user', 'restart', SYSTEMD_UNIT])
    return { ok: true }
  }
  if (deps.platform === 'win32') {
    const r = await deps.exec('schtasks', windowsTaskArgs(cmd))
    if (r.code !== 0) return failed('schtasks /Create', r)
    const run = await deps.exec('schtasks', ['/Run', '/TN', WINDOWS_TASK])
    if (run.code === 0) return { ok: true }
    await deps.exec('schtasks', ['/Delete', '/F', '/TN', WINDOWS_TASK])
    return failed('schtasks /Run', run)
  }
  return { ok: false, error: `Running scheduled runs while Houston is closed isn't supported on ${deps.platform}.` }
}

/** Stop the login agent and remove it. Succeeds when there was nothing installed. */
export async function uninstallLoginAgent(deps: LoginAgentDeps): Promise<LoginAgentResult> {
  const path = loginAgentPath(deps.platform, deps.home)
  if (deps.platform === 'darwin') {
    if (deps.uid !== undefined) await deps.exec('launchctl', ['bootout', `gui/${deps.uid}/${LOGIN_AGENT_LABEL}`])
    deps.removeFile(path!)
    return { ok: true }
  }
  if (deps.platform === 'linux') {
    await deps.exec('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT])
    deps.removeFile(path!)
    await deps.exec('systemctl', ['--user', 'daemon-reload'])
    return { ok: true }
  }
  if (deps.platform === 'win32') {
    await deps.exec('schtasks', ['/End', '/TN', WINDOWS_TASK])
    const r = await deps.exec('schtasks', ['/Delete', '/F', '/TN', WINDOWS_TASK])
    // Not found is fine: there was nothing to remove.
    return r.code === 0 || /cannot find|does not exist/i.test(`${r.stderr}${r.stdout}`) ? { ok: true } : failed('schtasks /Delete', r)
  }
  return { ok: true }
}

/**
 * Whether the login agent is installed with exactly this command, so a caller can
 * reinstall after the executable moved (an update, a reinstall elsewhere).
 */
export async function loginAgentMatches(cmd: DaemonCommand, deps: LoginAgentDeps): Promise<boolean> {
  const path = loginAgentPath(deps.platform, deps.home)
  if (deps.platform === 'darwin') return deps.readFile(path!) === launchAgentPlist(cmd)
  if (deps.platform === 'linux') return deps.readFile(path!) === systemdUnit(cmd)
  // Task Scheduler's own export is awkward to compare (UTF-16 XML), and the caller
  // points the task at a launcher path that stays put across updates, so on Windows
  // the task existing is enough.
  if (deps.platform === 'win32') return (await deps.exec('schtasks', ['/Query', '/TN', WINDOWS_TASK])).code === 0
  return false
}

/** Whether this platform has a login agent Houston can install. */
export function loginAgentSupported(platform: NodeJS.Platform): boolean {
  return platform === 'darwin' || platform === 'linux' || platform === 'win32'
}

/** The schedule daemon's state, as Settings and `houston schedule-daemon status` show it. */
export interface ScheduleDaemonState {
  supported: boolean
  /** The login agent is installed. */
  installed: boolean
  /** The daemon's pid, when one is running for this profile. */
  pid: number | null
}

export async function scheduleDaemonState(
  deps: LoginAgentDeps,
  runningPid: () => number | null
): Promise<ScheduleDaemonState> {
  const supported = loginAgentSupported(deps.platform)
  const path = loginAgentPath(deps.platform, deps.home)
  const installed = !supported
    ? false
    : path
      ? deps.readFile(path) !== null
      : (await deps.exec('schtasks', ['/Query', '/TN', WINDOWS_TASK])).code === 0
  return { supported, installed, pid: runningPid() }
}

/**
 * Turn the daemon off: remove the login agent, and stop a daemon still running for
 * this profile (one started by hand, or one the OS didn't stop with its entry).
 */
export async function disableScheduleDaemon(
  deps: LoginAgentDeps,
  runningPid: () => number | null,
  kill: (pid: number) => void = (pid) => process.kill(pid, 'SIGTERM')
): Promise<LoginAgentResult> {
  const r = await uninstallLoginAgent(deps)
  const pid = runningPid()
  if (pid !== null && pid !== process.pid) {
    try {
      kill(pid)
    } catch {
      // Already gone.
    }
  }
  return r
}

/** The real OS seams. */
export function realLoginAgentDeps(): LoginAgentDeps {
  return {
    platform: process.platform,
    home: homedir(),
    ...(typeof process.getuid === 'function' ? { uid: process.getuid() } : {}),
    exec: (file, args) =>
      new Promise((resolve) => {
        execFile(file, args, { timeout: 30_000, windowsHide: true }, (err, stdout, stderr) => {
          const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : 1) : 0
          resolve({ code, stdout: String(stdout), stderr: String(stderr || (err && !stderr ? err.message : '')) })
        })
      }),
    writeFile: (path, content) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content, { mode: 0o644 })
    },
    readFile: (path) => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return null
      }
    },
    removeFile: (path) => {
      if (existsSync(path)) unlinkSync(path)
    }
  }
}
