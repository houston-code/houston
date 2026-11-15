import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LOGIN_AGENT_LABEL,
  SYSTEMD_UNIT,
  WINDOWS_RUN_KEY,
  WINDOWS_TASK,
  disableScheduleDaemon,
  installLoginAgent,
  launchAgentPlist,
  loginAgentMatches,
  loginAgentPath,
  parseRunKeyValue,
  scheduleDaemonState,
  startsAppDaemon,
  systemdUnit,
  uninstallLoginAgent,
  windowsCommandLine,
  windowsRunKeyArgs,
  type DaemonCommand,
  type LoginAgentDeps
} from './loginAgent'
import { PID_STALE_MS, daemonPidPath, runningDaemonPid } from './scheduleDaemon'

/** Fake OS seams: an in-memory file map and a scripted command runner. */
type Result = { code: number; stdout?: string; stderr?: string }

function fakeDeps(
  platform: NodeJS.Platform,
  results: Record<string, Result | Result[]> = {}
): LoginAgentDeps & { files: Map<string, string>; calls: string[]; spawned: string[][] } {
  const files = new Map<string, string>()
  const calls: string[] = []
  const spawned: string[][] = []
  return {
    platform,
    home: '/home/u',
    uid: 501,
    files,
    calls,
    spawned,
    exec: async (file, args) => {
      const line = [file, ...args].join(' ')
      calls.push(line)
      const entry = Object.entries(results).find(([prefix]) => line.startsWith(prefix))?.[1]
      // A list answers successive calls in turn, then repeats its last answer.
      const hit = Array.isArray(entry) ? (entry.length > 1 ? entry.shift() : entry[0]) : entry
      return { code: hit?.code ?? 0, stdout: hit?.stdout ?? '', stderr: hit?.stderr ?? '' }
    },
    writeFile: (p, c) => void files.set(p, c),
    readFile: (p) => files.get(p) ?? null,
    removeFile: (p) => void files.delete(p),
    spawnDetached: async (file, args) => {
      spawned.push([file, ...args])
      return { ok: true }
    },
    sleep: async () => {}
  }
}

/** What `reg query` prints for the Run value. */
const regQuery = (value: string): string =>
  `\r\n${WINDOWS_RUN_KEY}\r\n    ${WINDOWS_TASK}    REG_SZ    ${value}\r\n\r\n`

const cmd: DaemonCommand = {
  program: '/Applications/Houston.app/Contents/MacOS/Houston',
  args: ['--schedule-daemon'],
  logFile: '/home/u/profile/schedule-daemon.out.log'
}

describe('login agent files', () => {
  it('writes a LaunchAgent that runs the command at load, restarts it after a crash, and escapes values', () => {
    const plist = launchAgentPlist({ ...cmd, args: ['--schedule-daemon', 'a&b<c>"'], env: { HOUSTON_DATA_DIR: '/x & y' } })
    expect(plist).toContain(`<string>${LOGIN_AGENT_LABEL}</string>`)
    expect(plist).toContain('<string>/Applications/Houston.app/Contents/MacOS/Houston</string>\n    <string>--schedule-daemon</string>')
    expect(plist).toContain('<string>a&amp;b&lt;c&gt;&quot;</string>')
    expect(plist).toContain('<key>HOUSTON_DATA_DIR</key>\n    <string>/x &amp; y</string>')
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/)
    expect(plist).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/)
    expect(plist).toContain('<string>/home/u/profile/schedule-daemon.out.log</string>')
  })

  it('writes a systemd user unit with every word quoted and specifiers escaped', () => {
    const unit = systemdUnit({ program: '/opt/Hou ston/houston', args: ['--schedule-daemon', '50%', 'a"b', '$HOME', 'c\\d'] })
    expect(unit).toContain('ExecStart="/opt/Hou ston/houston" "--schedule-daemon" "50%%" "a\\"b" "$$HOME" "c\\\\d"')
    expect(unit).toContain('Restart=on-failure')
    expect(unit).toContain('SuccessExitStatus=129 130 143')
    expect(unit).toContain('WantedBy=default.target')
    expect(systemdUnit({ ...cmd, env: { HOUSTON_DATA_DIR: '/d' } })).toContain('Environment="HOUSTON_DATA_DIR=/d"')
  })

  it('keeps a $ as it is in Environment=, which systemd does not expand, while ExecStart still doubles it', () => {
    const unit = systemdUnit({ program: '/opt/a$b/houston', args: [], env: { HOUSTON_DATA_DIR: '/home/u/my$data 50%' } })
    expect(unit).toContain('Environment="HOUSTON_DATA_DIR=/home/u/my$data 50%%"')
    expect(unit).toContain('ExecStart="/opt/a$$b/houston"')
  })

  it("writes the Windows entry to the current user's Run key, quoted by the C runtime rules", () => {
    const args = windowsRunKeyArgs({ program: 'C:\\Users\\A B\\Houston.exe', args: ['--schedule-daemon', 'say "hi"', 'dir\\'] })
    expect(args.slice(0, 7)).toEqual(['add', WINDOWS_RUN_KEY, '/v', WINDOWS_TASK, '/t', 'REG_SZ', '/d'])
    expect(WINDOWS_RUN_KEY).toMatch(/^HKCU\\/)
    expect(args[7]).toBe('"C:\\Users\\A B\\Houston.exe" --schedule-daemon "say \\"hi\\"" dir\\')
    expect(args[8]).toBe('/f')
    // Nothing that needs an administrator: no Task Scheduler logon trigger.
    expect(args.join(' ')).not.toMatch(/ONLOGON|HKLM/)
  })

  it("reads the Run value back from reg's output", () => {
    expect(parseRunKeyValue(regQuery('"C:\\A B\\Houston.exe" --schedule-daemon'))).toBe('"C:\\A B\\Houston.exe" --schedule-daemon')
    expect(parseRunKeyValue('ERROR: The system was unable to find the specified registry key or value.')).toBeNull()
  })

  it("tells the desktop app's entry from the terminal's", () => {
    expect(startsAppDaemon(launchAgentPlist(cmd))).toBe(true)
    expect(startsAppDaemon(systemdUnit(cmd))).toBe(true)
    expect(startsAppDaemon(windowsCommandLine({ program: 'C:\\H\\Houston.exe', args: ['--schedule-daemon'] }))).toBe(true)
    expect(startsAppDaemon('<Exec><Command>C:\\H\\Houston.exe</Command><Arguments>--schedule-daemon</Arguments></Exec>')).toBe(true)
    const cli = { program: '/usr/bin/node', args: ['/opt/houston/cli.cjs', 'schedule-daemon', 'run'] }
    expect(startsAppDaemon(launchAgentPlist(cli))).toBe(false)
    expect(startsAppDaemon(systemdUnit(cli))).toBe(false)
    expect(startsAppDaemon(windowsCommandLine(cli))).toBe(false)
  })

  it('keeps each entry in the per-user location', () => {
    expect(loginAgentPath('darwin', '/h')).toBe(join('/h', 'Library', 'LaunchAgents', `${LOGIN_AGENT_LABEL}.plist`))
    expect(loginAgentPath('linux', '/h')).toBe(join('/h', '.config', 'systemd', 'user', SYSTEMD_UNIT))
    expect(loginAgentPath('win32', '/h')).toBeNull()
  })
})

describe('installing and removing', () => {
  it('macOS: writes the plist, replaces a loaded copy, and bootstraps it in the user domain', async () => {
    const d = fakeDeps('darwin')
    expect(await installLoginAgent(cmd, d)).toEqual({ ok: true })
    expect(d.files.get(loginAgentPath('darwin', '/home/u')!)).toBe(launchAgentPlist(cmd))
    expect(d.calls).toEqual([
      `launchctl bootout gui/501/${LOGIN_AGENT_LABEL}`,
      `launchctl bootstrap gui/501 ${loginAgentPath('darwin', '/home/u')}`
    ])
    expect(await loginAgentMatches(cmd, d)).toBe(true)
    expect(await loginAgentMatches({ ...cmd, program: '/elsewhere/Houston' }, d)).toBe(false)

    expect(await uninstallLoginAgent(d)).toEqual({ ok: true })
    expect(d.files.size).toBe(0)
    expect(d.calls.at(-1)).toBe(`launchctl bootout gui/501/${LOGIN_AGENT_LABEL}`)
  })

  it('macOS: reports a failed bootstrap with its first error line', async () => {
    const d = fakeDeps('darwin', { 'launchctl bootstrap': { code: 5, stderr: 'Bootstrap failed: 5: Input/output error\nmore' } })
    expect(await installLoginAgent(cmd, d)).toEqual({
      ok: false,
      error: 'launchctl bootstrap failed: Bootstrap failed: 5: Input/output error'
    })
    // Nothing is left behind to look installed.
    expect(d.files.size).toBe(0)
  })

  it('macOS: a reinstall waits for the old job to unload, and retries a bootstrap that fails while it goes', async () => {
    const path = loginAgentPath('darwin', '/home/u')!
    const d = fakeDeps('darwin', {
      // Still loaded on the first look, gone on the second.
      'launchctl print': [{ code: 0 }, { code: 113 }],
      'launchctl bootstrap': [{ code: 5, stderr: 'Bootstrap failed: 5: Input/output error' }, { code: 0 }]
    })
    d.files.set(path, launchAgentPlist({ ...cmd, program: '/old/Houston' }))
    expect(await installLoginAgent(cmd, d)).toEqual({ ok: true })
    expect(d.files.get(path)).toBe(launchAgentPlist(cmd))
    expect(d.calls).toEqual([
      `launchctl bootout gui/501/${LOGIN_AGENT_LABEL}`,
      `launchctl print gui/501/${LOGIN_AGENT_LABEL}`,
      `launchctl print gui/501/${LOGIN_AGENT_LABEL}`,
      `launchctl bootstrap gui/501 ${path}`,
      `launchctl bootstrap gui/501 ${path}`
    ])
  })

  it('macOS: a reinstall that keeps failing puts the previous agent back instead of leaving none', async () => {
    const path = loginAgentPath('darwin', '/home/u')!
    const old = launchAgentPlist({ ...cmd, program: '/old/Houston' })
    const d = fakeDeps('darwin', {
      'launchctl print': { code: 113 },
      'launchctl bootstrap': { code: 5, stderr: 'Bootstrap failed: 5: Input/output error' }
    })
    d.files.set(path, old)
    expect(await installLoginAgent(cmd, d)).toEqual({
      ok: false,
      error: 'launchctl bootstrap failed: Bootstrap failed: 5: Input/output error'
    })
    expect(d.files.get(path)).toBe(old)
    // Three tries with the new plist, then the old one is loaded again.
    expect(d.calls.filter((c) => c.startsWith('launchctl bootstrap')).length).toBe(4)
  })

  it('Linux: writes the unit, reloads, enables and starts it, and restarts a running copy', async () => {
    const d = fakeDeps('linux')
    expect(await installLoginAgent(cmd, d)).toEqual({ ok: true })
    expect(d.calls).toEqual([
      'systemctl --user daemon-reload',
      `systemctl --user enable --now ${SYSTEMD_UNIT}`,
      `systemctl --user restart ${SYSTEMD_UNIT}`
    ])
    expect(await uninstallLoginAgent(d)).toEqual({ ok: true })
    expect(d.calls.slice(-2)).toEqual([`systemctl --user disable --now ${SYSTEMD_UNIT}`, 'systemctl --user daemon-reload'])
    expect(d.files.size).toBe(0)
  })

  it('Linux: says so when there is no user systemd', async () => {
    const d = fakeDeps('linux', { 'systemctl --user daemon-reload': { code: 1, stderr: 'Failed to connect to bus: No medium found' } })
    expect(await installLoginAgent(cmd, d)).toEqual({
      ok: false,
      error: 'systemctl --user daemon-reload failed: Failed to connect to bus: No medium found'
    })
    expect(d.files.size).toBe(0)
  })

  it('Linux: undoes the unit when enabling it fails', async () => {
    const d = fakeDeps('linux', { 'systemctl --user enable': { code: 1, stderr: 'Unit failed' } })
    expect(await installLoginAgent(cmd, d)).toEqual({ ok: false, error: 'systemctl --user enable failed: Unit failed' })
    expect(d.files.size).toBe(0)
    expect(d.calls).toContain(`systemctl --user disable ${SYSTEMD_UNIT}`)
  })

  it('Windows: removes the Run value when the daemon will not start', async () => {
    const d = fakeDeps('win32')
    d.spawnDetached = async () => ({ ok: false, error: "Couldn't start C:\\H\\Houston.exe: spawn ENOENT" })
    expect(await installLoginAgent(cmd, d)).toEqual({ ok: false, error: "Couldn't start C:\\H\\Houston.exe: spawn ENOENT" })
    expect(d.calls.at(-1)).toBe(`reg delete ${WINDOWS_RUN_KEY} /v ${WINDOWS_TASK} /f`)
  })

  it('Windows: writes the Run value, removes an older logon task, and starts the daemon; removing a missing one is fine', async () => {
    const missing = { code: 1, stderr: 'ERROR: The system cannot find the file specified.' }
    const d = fakeDeps('win32', {
      'schtasks /Delete': missing,
      'reg delete': { code: 1, stderr: 'ERROR: The system was unable to find the specified registry key or value.' }
    })
    expect(await installLoginAgent(cmd, d)).toEqual({ ok: true })
    expect(d.calls).toEqual([['reg', ...windowsRunKeyArgs(cmd)].join(' '), `schtasks /Delete /F /TN ${WINDOWS_TASK}`])
    expect(d.spawned).toEqual([[cmd.program, ...cmd.args]])
    expect(await uninstallLoginAgent(d)).toEqual({ ok: true })
    expect(d.calls.slice(-3)).toEqual([
      `reg delete ${WINDOWS_RUN_KEY} /v ${WINDOWS_TASK} /f`,
      `schtasks /End /TN ${WINDOWS_TASK}`,
      `schtasks /Delete /F /TN ${WINDOWS_TASK}`
    ])
  })

  it('Windows: refuses a profile override it has no way to pass on, rather than run the default profile', async () => {
    const d = fakeDeps('win32')
    expect(await installLoginAgent({ ...cmd, env: { HOUSTON_DATA_DIR: 'D:\\p' } }, d)).toEqual({
      ok: false,
      error: expect.stringMatching(/can't keep HOUSTON_DATA_DIR/)
    })
    expect(d.calls).toEqual([])
    expect(d.spawned).toEqual([])
  })

  it('Windows: matches the Run value against the command, and reports the entry installed', async () => {
    const line = windowsCommandLine(cmd)
    const d = fakeDeps('win32', { 'reg query': { code: 0, stdout: regQuery(line) } })
    expect(await loginAgentMatches(cmd, d)).toBe(true)
    expect(await loginAgentMatches({ ...cmd, program: 'C:\\elsewhere\\Houston.exe' }, d)).toBe(false)
    expect(await scheduleDaemonState(d, () => null)).toEqual({ supported: true, installed: true, byApp: true, pid: null })
    // An older version's logon task counts as installed, but never as matching.
    const legacy = fakeDeps('win32', {
      'reg query': { code: 1, stderr: 'ERROR: The system was unable to find the specified registry key or value.' },
      'schtasks /Query': { code: 0, stdout: '<Task><Actions><Exec><Arguments>--schedule-daemon</Arguments></Exec></Actions></Task>' }
    })
    expect(await scheduleDaemonState(legacy, () => null)).toEqual({ supported: true, installed: true, byApp: true, pid: null })
    expect(await loginAgentMatches(cmd, legacy)).toBe(false)
    const none = fakeDeps('win32', { 'reg query': { code: 1 }, 'schtasks /Query': { code: 1 } })
    expect((await scheduleDaemonState(none, () => null)).installed).toBe(false)
  })

  it('refuses a platform without a login agent', async () => {
    const d = fakeDeps('freebsd')
    expect(await installLoginAgent(cmd, d)).toEqual({ ok: false, error: expect.stringMatching(/isn't supported on freebsd/) })
    expect(d.calls).toEqual([])
  })
})

describe('daemon state and turning it off', () => {
  it('reports installed and running from the entry and the pid file', async () => {
    const d = fakeDeps('linux')
    expect(await scheduleDaemonState(d, () => null)).toEqual({ supported: true, installed: false, byApp: false, pid: null })
    await installLoginAgent(cmd, d)
    expect(await scheduleDaemonState(d, () => 4242)).toEqual({ supported: true, installed: true, byApp: true, pid: 4242 })
    await installLoginAgent({ program: '/usr/bin/node', args: ['/opt/houston/cli.cjs', 'schedule-daemon', 'run'] }, d)
    expect(await scheduleDaemonState(d, () => null)).toEqual({ supported: true, installed: true, byApp: false, pid: null })
    expect(await scheduleDaemonState(fakeDeps('freebsd'), () => null)).toEqual({
      supported: false,
      installed: false,
      byApp: false,
      pid: null
    })
  })

  it('does not signal a pid named by a pid file its holder stopped refreshing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'houston-agent-'))
    try {
      writeFileSync(daemonPidPath(dir), '4242')
      const alive = (pid: number): boolean => pid === 4242
      const later = (): number => Date.now() + PID_STALE_MS + 1000
      const d = fakeDeps('darwin')
      const killed: number[] = []
      await disableScheduleDaemon(d, () => runningDaemonPid(dir, alive, later), (pid) => killed.push(pid))
      expect(killed).toEqual([])
      await disableScheduleDaemon(d, () => runningDaemonPid(dir, alive), (pid) => killed.push(pid))
      expect(killed).toEqual([4242])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('removes the entry and stops a daemon still running, never this process', async () => {
    const d = fakeDeps('darwin')
    await installLoginAgent(cmd, d)
    const killed: number[] = []
    expect(await disableScheduleDaemon(d, () => 4242, (pid) => killed.push(pid))).toEqual({ ok: true })
    expect(killed).toEqual([4242])
    await disableScheduleDaemon(d, () => process.pid, (pid) => killed.push(pid))
    expect(killed).toEqual([4242])
  })
})
