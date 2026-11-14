import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  LOGIN_AGENT_LABEL,
  SYSTEMD_UNIT,
  WINDOWS_TASK,
  disableScheduleDaemon,
  installLoginAgent,
  launchAgentPlist,
  loginAgentMatches,
  loginAgentPath,
  scheduleDaemonState,
  systemdUnit,
  uninstallLoginAgent,
  windowsTaskArgs,
  type DaemonCommand,
  type LoginAgentDeps
} from './loginAgent'

/** Fake OS seams: an in-memory file map and a scripted command runner. */
function fakeDeps(
  platform: NodeJS.Platform,
  results: Record<string, { code: number; stdout?: string; stderr?: string }> = {}
): LoginAgentDeps & { files: Map<string, string>; calls: string[] } {
  const files = new Map<string, string>()
  const calls: string[] = []
  return {
    platform,
    home: '/home/u',
    uid: 501,
    files,
    calls,
    exec: async (file, args) => {
      const line = [file, ...args].join(' ')
      calls.push(line)
      const hit = Object.entries(results).find(([prefix]) => line.startsWith(prefix))?.[1]
      return { code: hit?.code ?? 0, stdout: hit?.stdout ?? '', stderr: hit?.stderr ?? '' }
    },
    writeFile: (p, c) => void files.set(p, c),
    readFile: (p) => files.get(p) ?? null,
    removeFile: (p) => void files.delete(p)
  }
}

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

  it('quotes the Windows task command line by the C runtime rules', () => {
    const args = windowsTaskArgs({ program: 'C:\\Users\\A B\\Houston.exe', args: ['--schedule-daemon', 'say "hi"', 'dir\\'] })
    expect(args.slice(0, 9)).toEqual(['/Create', '/F', '/SC', 'ONLOGON', '/RL', 'LIMITED', '/TN', WINDOWS_TASK, '/TR'])
    expect(args[9]).toBe('"C:\\Users\\A B\\Houston.exe" --schedule-daemon "say \\"hi\\"" dir\\')
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

  it('Windows: deletes the task when it will not start', async () => {
    const d = fakeDeps('win32', { 'schtasks /Run': { code: 1, stderr: 'ERROR: Access is denied.' } })
    expect(await installLoginAgent(cmd, d)).toEqual({ ok: false, error: 'schtasks /Run failed: ERROR: Access is denied.' })
    expect(d.calls.at(-1)).toBe(`schtasks /Delete /F /TN ${WINDOWS_TASK}`)
  })

  it('Windows: creates a logon task and starts it; removing a missing one is fine', async () => {
    const d = fakeDeps('win32', { 'schtasks /Delete': { code: 1, stderr: 'ERROR: The system cannot find the file specified.' } })
    expect(await installLoginAgent(cmd, d)).toEqual({ ok: true })
    expect(d.calls[0]).toBe(['schtasks', ...windowsTaskArgs(cmd)].join(' '))
    expect(d.calls[1]).toBe(`schtasks /Run /TN ${WINDOWS_TASK}`)
    expect(await uninstallLoginAgent(d)).toEqual({ ok: true })
    expect(d.calls.slice(-2)).toEqual([`schtasks /End /TN ${WINDOWS_TASK}`, `schtasks /Delete /F /TN ${WINDOWS_TASK}`])
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
    expect(await scheduleDaemonState(d, () => null)).toEqual({ supported: true, installed: false, pid: null })
    await installLoginAgent(cmd, d)
    expect(await scheduleDaemonState(d, () => 4242)).toEqual({ supported: true, installed: true, pid: 4242 })
    expect(await scheduleDaemonState(fakeDeps('freebsd'), () => null)).toEqual({ supported: false, installed: false, pid: null })
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
