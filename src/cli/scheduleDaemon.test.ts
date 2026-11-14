import { describe, expect, it } from 'vitest'
import type { DaemonCommand, LoginAgentResult, ScheduleDaemonState } from '../main/loginAgent'
import { SCHEDULE_DAEMON_USAGE, runScheduleDaemonCommand, type ScheduleDaemonCliDeps } from './scheduleDaemon'

function deps(over: Partial<ScheduleDaemonCliDeps> = {}, state: Partial<ScheduleDaemonState> = {}) {
  const out: string[] = []
  const err: string[] = []
  const installed: DaemonCommand[] = []
  let ran = 0
  let removed = 0
  const d: ScheduleDaemonCliDeps = {
    run: async () => {
      ran++
      return 0
    },
    install: async (cmd): Promise<LoginAgentResult> => {
      installed.push(cmd)
      return { ok: true }
    },
    uninstall: async (): Promise<LoginAgentResult> => {
      removed++
      return { ok: true }
    },
    state: async () => ({ supported: true, installed: false, pid: null, ...state }),
    command: () => ({ program: '/usr/bin/node', args: ['/opt/houston/cli.js', 'schedule-daemon', 'run'] }),
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    ...over
  }
  return { d, out, err, installed, counts: () => ({ ran, removed }) }
}

describe('houston schedule-daemon', () => {
  it('runs in the foreground by default and with run', async () => {
    const t = deps()
    expect(await runScheduleDaemonCommand([], t.d)).toBe(0)
    expect(await runScheduleDaemonCommand(['run'], t.d)).toBe(0)
    expect(t.counts().ran).toBe(2)
  })

  it('installs the login agent with this CLI in run mode', async () => {
    const t = deps()
    expect(await runScheduleDaemonCommand(['install'], t.d)).toBe(0)
    expect(t.installed).toEqual([{ program: '/usr/bin/node', args: ['/opt/houston/cli.js', 'schedule-daemon', 'run'] }])
    expect(t.out.join('')).toMatch(/^Installed: scheduled runs now fire while Houston is closed\./)
  })

  it('says why an install failed, and refuses an unsupported platform', async () => {
    const failing = deps({ install: async () => ({ ok: false, error: 'systemctl --user daemon-reload failed: no bus' }) })
    expect(await runScheduleDaemonCommand(['install'], failing.d)).toBe(1)
    expect(failing.err.join('')).toBe("houston: couldn't install the schedule daemon: systemctl --user daemon-reload failed: no bus\n")
    const unsupported = deps({}, { supported: false })
    expect(await runScheduleDaemonCommand(['install'], unsupported.d)).toBe(1)
    expect(unsupported.installed).toEqual([])
    expect(unsupported.err.join('')).toMatch(/not supported on this platform/)
  })

  it('uninstalls, and reports status', async () => {
    const t = deps({}, { installed: true, pid: 321 })
    expect(await runScheduleDaemonCommand(['uninstall'], t.d)).toBe(0)
    expect(t.counts().removed).toBe(1)
    expect(await runScheduleDaemonCommand(['status'], t.d)).toBe(0)
    expect(t.out.slice(-2)).toEqual(['Login agent: installed.\n', 'Daemon: running (pid 321).\n'])
    const idle = deps()
    await runScheduleDaemonCommand(['status'], idle.d)
    expect(idle.out).toEqual(['Login agent: not installed.\n', 'Daemon: not running.\n'])
  })

  it('prints help, and rejects an unknown command with the usage', async () => {
    const t = deps()
    expect(await runScheduleDaemonCommand(['--help'], t.d)).toBe(0)
    expect(t.out).toEqual([SCHEDULE_DAEMON_USAGE])
    expect(await runScheduleDaemonCommand(['restart'], t.d)).toBe(2)
    expect(t.err.join('')).toBe(`houston: unknown schedule-daemon command "restart".\n\n${SCHEDULE_DAEMON_USAGE}`)
    expect(t.counts().ran).toBe(0)
  })
})
