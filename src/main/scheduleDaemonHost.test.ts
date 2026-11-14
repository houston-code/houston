import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'

vi.mock('./logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { appDaemonCommand, ensureScheduleDaemon, setScheduleDaemon, type ScheduleDaemonHostDeps } from './scheduleDaemonHost'
import { launchAgentPlist, loginAgentPath, type LoginAgentDeps } from './loginAgent'

function login(results: Record<string, number> = {}): LoginAgentDeps & { files: Map<string, string>; calls: string[] } {
  const files = new Map<string, string>()
  const calls: string[] = []
  return {
    platform: 'darwin',
    home: '/home/mac-user',
    uid: 501,
    files,
    calls,
    exec: async (file, args) => {
      const line = [file, ...args].join(' ')
      calls.push(line)
      const code = Object.entries(results).find(([p]) => line.startsWith(p))?.[1] ?? 0
      return { code, stdout: '', stderr: code ? 'boom' : '' }
    },
    writeFile: (p, c) => void files.set(p, c),
    readFile: (p) => files.get(p) ?? null,
    removeFile: (p) => void files.delete(p)
  }
}

describe('appDaemonCommand', () => {
  const userData = '/profile'
  it('starts a packaged app binary in daemon mode', () => {
    expect(
      appDaemonCommand({ execPath: '/Applications/Houston.app/Contents/MacOS/Houston', isPackaged: true, appPath: '/x', platform: 'darwin' }, userData)
    ).toEqual({
      program: '/Applications/Houston.app/Contents/MacOS/Houston',
      args: ['--schedule-daemon'],
      logFile: join(userData, 'schedule-daemon.out.log')
    })
  })

  it('starts the AppImage file itself on Linux, and Electron with the app path in a dev run', () => {
    expect(
      appDaemonCommand(
        { execPath: '/tmp/.mount_HoustXY/houston', isPackaged: true, appPath: '/x', platform: 'linux', appImage: '/home/u/Houston.AppImage' },
        userData
      ).program
    ).toBe('/home/u/Houston.AppImage')
    expect(
      appDaemonCommand({ execPath: '/repo/node_modules/electron/dist/electron', isPackaged: false, appPath: '/repo', platform: 'linux' }, userData)
        .args
    ).toEqual(['/repo', '--schedule-daemon'])
  })

  it("points Windows at the install's launcher, which survives updates, when it exists", () => {
    const exe = 'C:\\Users\\u\\AppData\\Local\\Houston\\app-1.2.3\\Houston.exe'
    const stub = 'C:\\Users\\u\\AppData\\Local\\Houston\\Houston.exe'
    const cmd = appDaemonCommand({ execPath: exe, isPackaged: true, appPath: '/x', platform: 'win32', exists: (p) => p === stub }, userData)
    expect(cmd.program).toBe(stub)
    // No launcher (a portable copy): the binary itself.
    expect(appDaemonCommand({ execPath: exe, isPackaged: true, appPath: '/x', platform: 'win32', exists: () => false }, userData).program).toBe(exe)
  })
})

describe('the Settings toggle', () => {
  const cmd = { program: '/Applications/Houston.app/Contents/MacOS/Houston', args: ['--schedule-daemon'] }
  const host = (l: LoginAgentDeps, pid: number | null = null): ScheduleDaemonHostDeps => ({
    command: () => cmd,
    login: l,
    runningPid: () => pid
  })

  it('turns on by installing the login agent, and off by removing it', async () => {
    const l = login()
    expect(await setScheduleDaemon(true, host(l, 77))).toEqual({ supported: true, installed: true, running: true })
    expect(l.files.get(loginAgentPath('darwin', '/home/mac-user')!)).toBe(launchAgentPlist(cmd))
    expect(await setScheduleDaemon(false, host(l))).toEqual({ supported: true, installed: false, running: false })
    expect(l.files.size).toBe(0)
  })

  it('reports a failed install and stays off', async () => {
    const l = login({ 'launchctl bootstrap': 5 })
    expect(await setScheduleDaemon(true, host(l))).toEqual({
      supported: true,
      // What launchctl refused is not left installed.
      installed: false,
      running: false,
      error: 'launchctl bootstrap failed: boom'
    })
  })

  it('at startup, reinstalls an installed agent that starts another executable, and leaves a missing one alone', async () => {
    const l = login()
    await ensureScheduleDaemon(host(l))
    expect(l.calls).toEqual([])
    l.files.set(loginAgentPath('darwin', '/home/mac-user')!, launchAgentPlist({ ...cmd, program: '/old/Houston' }))
    await ensureScheduleDaemon(host(l))
    expect(l.files.get(loginAgentPath('darwin', '/home/mac-user')!)).toBe(launchAgentPlist(cmd))
    expect(l.calls.at(-1)).toMatch(/^launchctl bootstrap gui\/501 /)
    const before = l.calls.length
    await ensureScheduleDaemon(host(l))
    expect(l.calls.length).toBe(before)
  })
})
