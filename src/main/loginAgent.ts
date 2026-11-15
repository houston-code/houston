import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * The per-user login agent that keeps the schedule daemon running while Houston is
 * closed, so scheduled runs fire on time instead of at the next launch.
 *
 * One entry per platform, installed for the current user only (never system-wide, no
 * elevation): a LaunchAgent on macOS, a systemd user unit on Linux, a value under the
 * current user's Run key on Windows. Each starts `program` with `args` (the Houston
 * executable in daemon mode) and is started right away when installed. Uninstall stops
 * it and removes the entry. Nothing here runs a shell: every command is execFile with
 * literal arguments, and the file contents escape every value they embed.
 *
 * The OS seams (files, commands, the home folder) are injected so the plans can be
 * tested on any platform without touching the real login items.
 */

/**
 * The LaunchAgent label, the systemd unit, and the Windows Run value name (also the
 * name of the Task Scheduler task earlier versions created, removed on install).
 */
export const LOGIN_AGENT_LABEL = 'ai.houstoncode.houston.schedule-daemon'
export const SYSTEMD_UNIT = 'houston-schedule-daemon.service'
export const WINDOWS_TASK = 'Houston schedule daemon'
/** The current user's Run key: what it names starts at that user's logon. */
export const WINDOWS_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'

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
  /**
   * Start a program in the background, detached from this process, with extra
   * environment (Windows: the login entry has no "start it now" of its own).
   */
  spawnDetached?: (file: string, args: string[], env?: Record<string, string>) => Promise<LoginAgentResult>
  /** Wait between launchctl retries (tests pass an instant one). */
  sleep?: (ms: number) => Promise<void>
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
 * One quoted systemd value, with backslash, quote and `%` (a specifier) escaped. For
 * `ExecStart=` a `$` is doubled too, so it is never read as a variable; `Environment=`
 * does no variable expansion, so there a `$` stays as it is.
 */
function systemdQuoted(s: string, expands: boolean): string {
  const escaped = s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')
  return `"${expands ? escaped.replace(/\$/g, '$$$$') : escaped}"`
}

/** One `ExecStart=` word. */
function systemdWord(s: string): string {
  return systemdQuoted(s, true)
}

/** The systemd user unit (Linux). */
export function systemdUnit(cmd: DaemonCommand): string {
  const env = Object.entries(cmd.env ?? {}).map(([k, v]) => `Environment=${systemdQuoted(`${k}=${v}`, false)}\n`)
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
 * One Windows command-line word for the Run value: quoted when it has a space, tab or
 * quote, with quotes and the backslashes before them escaped (the MS C runtime rules).
 */
function windowsWord(s: string): string {
  if (s && !/[\s"]/.test(s)) return s
  return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`
}

/** The command line the Windows login entry starts. */
export function windowsCommandLine(cmd: DaemonCommand): string {
  return [cmd.program, ...cmd.args].map(windowsWord).join(' ')
}

/**
 * The `reg` arguments that write the login entry (Windows): a value under the current
 * user's Run key, which a standard user may write (a Task Scheduler logon trigger made
 * from the command line applies to every user, and needs an administrator).
 */
export function windowsRunKeyArgs(cmd: DaemonCommand): string[] {
  return ['add', WINDOWS_RUN_KEY, '/v', WINDOWS_TASK, '/t', 'REG_SZ', '/d', windowsCommandLine(cmd), '/f']
}

/** The Run key value `reg query` printed, or null when there is none. */
export function parseRunKeyValue(stdout: string): string | null {
  const name = WINDOWS_TASK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`^\\s*${name}\\s+REG_(?:EXPAND_)?SZ\\s+(.*?)\\s*$`, 'm').exec(stdout)
  return m ? m[1]! : null
}

const NOT_FOUND = /cannot find|does not exist|unable to find/i

/**
 * The installed login entry's text (the plist, the unit, or the Windows command line;
 * an older Windows install's task, as Task Scheduler exports it), or null when there is
 * none.
 */
export async function installedLoginAgent(deps: LoginAgentDeps): Promise<string | null> {
  const path = loginAgentPath(deps.platform, deps.home)
  if (path) return deps.readFile(path)
  if (deps.platform !== 'win32') return null
  const q = await deps.exec('reg', ['query', WINDOWS_RUN_KEY, '/v', WINDOWS_TASK])
  const value = q.code === 0 ? parseRunKeyValue(q.stdout) : null
  if (value !== null) return value
  const task = await deps.exec('schtasks', ['/Query', '/TN', WINDOWS_TASK, '/XML'])
  return task.code === 0 ? task.stdout : null
}

/**
 * Whether a login entry starts the desktop app's daemon (`Houston --schedule-daemon`)
 * rather than the terminal's (`houston schedule-daemon run`). Both install under the
 * same name, so each can tell the other's entry apart and leave it alone.
 */
export function startsAppDaemon(entry: string): boolean {
  return /(?:^|[\s>"])--schedule-daemon(?=$|[\s<"])/.test(entry)
}

function failed(what: string, r: { code: number; stderr: string; stdout: string }): LoginAgentResult {
  const detail = (r.stderr || r.stdout).trim().split('\n')[0]?.trim()
  return { ok: false, error: `${what} failed${detail ? `: ${detail}` : ` (exit ${r.code})`}` }
}

/** Polls for launchd to finish unloading a booted-out job, and bootstrap attempts. */
const LAUNCHD_UNLOAD_POLLS = 10
const LAUNCHD_UNLOAD_POLL_MS = 200
const LAUNCHD_BOOTSTRAP_ATTEMPTS = 3
const LAUNCHD_BOOTSTRAP_RETRY_MS = 500

/**
 * Install (or reinstall) the login agent and start it now. A failed first install
 * leaves nothing behind, so "installed" never describes an agent the OS refused; a
 * failed reinstall on macOS puts the previous agent back.
 */
export async function installLoginAgent(cmd: DaemonCommand, deps: LoginAgentDeps): Promise<LoginAgentResult> {
  const path = loginAgentPath(deps.platform, deps.home)
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  if (deps.platform === 'darwin') {
    if (deps.uid === undefined) return { ok: false, error: 'Unknown user id.' }
    const domain = `gui/${deps.uid}`
    const service = `${domain}/${LOGIN_AGENT_LABEL}`
    const previous = deps.readFile(path!)
    deps.writeFile(path!, launchAgentPlist(cmd))
    // A previous copy is replaced: unload it first (it may not be loaded), and give
    // launchd time to finish tearing it down, or bootstrap fails while it is still there.
    await deps.exec('launchctl', ['bootout', service])
    if (previous !== null) {
      for (let i = 0; i < LAUNCHD_UNLOAD_POLLS; i++) {
        if ((await deps.exec('launchctl', ['print', service])).code !== 0) break
        await sleep(LAUNCHD_UNLOAD_POLL_MS)
      }
    }
    let r = await deps.exec('launchctl', ['bootstrap', domain, path!])
    for (let i = 1; i < LAUNCHD_BOOTSTRAP_ATTEMPTS && r.code !== 0; i++) {
      await sleep(LAUNCHD_BOOTSTRAP_RETRY_MS)
      r = await deps.exec('launchctl', ['bootstrap', domain, path!])
    }
    if (r.code === 0) return { ok: true }
    if (previous !== null) {
      // Keep the agent that worked before rather than leaving none.
      deps.writeFile(path!, previous)
      await deps.exec('launchctl', ['bootstrap', domain, path!])
    } else {
      deps.removeFile(path!)
    }
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
    // A Run value is a bare command line: it can't carry environment, so a daemon for a
    // moved profile would start against the default one. Say so instead.
    if (Object.keys(cmd.env ?? {}).length) {
      return {
        ok: false,
        error: `A login entry on Windows can't keep ${Object.keys(cmd.env!).join(', ')}. Run \`houston schedule-daemon run\` from your own service manager instead.`
      }
    }
    if (!deps.spawnDetached) return { ok: false, error: "Can't start the daemon on this system." }
    const r = await deps.exec('reg', windowsRunKeyArgs(cmd))
    if (r.code !== 0) return failed('reg add', r)
    // An earlier version's logon task, if it was ever created, would start a second copy.
    await deps.exec('schtasks', ['/Delete', '/F', '/TN', WINDOWS_TASK])
    const run = await deps.spawnDetached(cmd.program, cmd.args, cmd.env)
    if (run.ok) return { ok: true }
    await deps.exec('reg', ['delete', WINDOWS_RUN_KEY, '/v', WINDOWS_TASK, '/f'])
    return run
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
    // The daemon itself is stopped by the caller (disableScheduleDaemon): a Run value
    // has no process of its own to end.
    const r = await deps.exec('reg', ['delete', WINDOWS_RUN_KEY, '/v', WINDOWS_TASK, '/f'])
    // An earlier version's logon task.
    await deps.exec('schtasks', ['/End', '/TN', WINDOWS_TASK])
    const task = await deps.exec('schtasks', ['/Delete', '/F', '/TN', WINDOWS_TASK])
    // Not found is fine: there was nothing to remove.
    if (r.code !== 0 && !NOT_FOUND.test(`${r.stderr}${r.stdout}`)) return failed('reg delete', r)
    if (task.code !== 0 && !NOT_FOUND.test(`${task.stderr}${task.stdout}`)) return failed('schtasks /Delete', task)
    return { ok: true }
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
  // An earlier version's logon task never matches, so it is moved to the Run key.
  if (deps.platform === 'win32') {
    const q = await deps.exec('reg', ['query', WINDOWS_RUN_KEY, '/v', WINDOWS_TASK])
    return q.code === 0 && parseRunKeyValue(q.stdout) === windowsCommandLine(cmd)
  }
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
  /** The installed agent starts the desktop app's daemon (not the terminal's). */
  byApp: boolean
  /** The daemon's pid, when one is running for this profile. */
  pid: number | null
}

export async function scheduleDaemonState(
  deps: LoginAgentDeps,
  runningPid: () => number | null
): Promise<ScheduleDaemonState> {
  const supported = loginAgentSupported(deps.platform)
  const entry = supported ? await installedLoginAgent(deps) : null
  return { supported, installed: entry !== null, byApp: entry !== null && startsAppDaemon(entry), pid: runningPid() }
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
    },
    spawnDetached: (file, args, env) =>
      new Promise((resolve) => {
        try {
          const child = spawn(file, args, {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
            env: { ...process.env, ...env }
          })
          child.once('error', (e) => resolve({ ok: false, error: `Couldn't start ${file}: ${e.message}` }))
          child.once('spawn', () => {
            child.unref()
            resolve({ ok: true })
          })
        } catch (e) {
          resolve({ ok: false, error: `Couldn't start ${file}: ${(e as Error).message}` })
        }
      })
  }
}
