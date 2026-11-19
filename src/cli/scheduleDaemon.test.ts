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
    state: async () => ({ supported: true, installed: false, byApp: false, pid: null, ...state }),
    command: () => ({ program: '/usr/bin/node', args: ['/opt/houston/cli.js', 'schedule-daemon', 'run'] }),
    envOnlyKeys: () => [],
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

  it("leaves the desktop app's login agent in place instead of replacing it, and repairs its own", async () => {
    const app = deps({}, { installed: true, byApp: true })
    expect(await runScheduleDaemonCommand(['install'], app.d)).toBe(1)
    expect(app.installed).toEqual([])
    expect(app.err.join('')).toMatch(/desktop app's schedule daemon is already installed/)
    await runScheduleDaemonCommand(['status'], app.d)
    expect(app.out[0]).toBe('Login agent: installed by the desktop app.\n')
    const own = deps({}, { installed: true, byApp: false })
    expect(await runScheduleDaemonCommand(['install'], own.d)).toBe(0)
    expect(own.installed.length).toBe(1)
  })

  it('refuses to install while a key scheduled runs need is only in the shell environment, and names the fix', async () => {
    const t = deps({
      envOnlyKeys: () => [
        { id: 'anthropic', envVar: 'ANTHROPIC_API_KEY', needed: true },
        { id: 'openrouter', envVar: 'HOUSTON_API_KEY_OPENROUTER', needed: true },
        { id: 'openai', envVar: 'OPENAI_API_KEY', needed: false }
      ]
    })
    expect(await runScheduleDaemonCommand(['install'], t.d)).toBe(1)
    expect(t.installed).toEqual([])
    const err = t.err.join('')
    expect(err).toMatch(/starts at login without your shell's environment/)
    expect(err).toContain('  anthropic (from ANTHROPIC_API_KEY)\n')
    expect(err).toContain('  printf %s "$ANTHROPIC_API_KEY" | houston providers set-key anthropic\n')
    expect(err).toContain('  printf %s "$HOUSTON_API_KEY_OPENROUTER" | houston providers set-key openrouter\n')
    // A provider nothing scheduled uses isn't part of the refusal.
    expect(err).not.toContain('openai')
  })

  it('installs with only a warning when an env-only key belongs to a provider no schedule uses', async () => {
    const t = deps({ envOnlyKeys: () => [{ id: 'openai', envVar: 'OPENAI_API_KEY', needed: false }] })
    expect(await runScheduleDaemonCommand(['install'], t.d)).toBe(0)
    expect(t.installed).toHaveLength(1)
    expect(t.err.join('')).toBe(
      "houston: note: the key for openai comes only from OPENAI_API_KEY, which the daemon won't see. No saved schedule uses it now; store it before scheduling runs on it:\n" +
        '  printf %s "$OPENAI_API_KEY" | houston providers set-key openai\n'
    )
    expect(t.out.join('')).toMatch(/^Installed:/)
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
