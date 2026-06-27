import { describe, expect, it } from 'vitest'
import { makeWindowsBackend, resolveWindowsBash, windowsLaunch } from './windows'

describe('resolveWindowsBash', () => {
  it('honors the HOUSTON_SHELL override when it exists', () => {
    const bash = resolveWindowsBash({
      env: { HOUSTON_SHELL: 'D:\\tools\\bash.exe' },
      exists: (p) => p === 'D:\\tools\\bash.exe'
    })
    expect(bash).toBe('D:\\tools\\bash.exe')
  })

  it('finds Git-for-Windows bash under Program Files', () => {
    const env = { ProgramFiles: 'C:\\Program Files' }
    const expected = 'C:\\Program Files\\Git\\bin\\bash.exe'
    expect(resolveWindowsBash({ env, exists: (p) => p === expected })).toBe(expected)
  })

  it('does NOT pick the WSL shim in System32 (only known Git locations / override)', () => {
    // The only "bash.exe" present is the WSL shim — resolver returns null (→ cmd.exe).
    const env = { ProgramFiles: 'C:\\Program Files' }
    const bash = resolveWindowsBash({
      env,
      exists: (p) => p === 'C:\\Windows\\System32\\bash.exe'
    })
    expect(bash).toBeNull()
  })

  it('returns null when no bash is found', () => {
    expect(resolveWindowsBash({ env: {}, exists: () => false })).toBeNull()
  })
})

describe('windowsLaunch', () => {
  it('uses bash -c when a bash is resolved, supporting the session prelude', () => {
    const l = windowsLaunch('echo hi', 'C:\\Program Files\\Git\\bin\\bash.exe')
    expect(l.file).toBe('C:\\Program Files\\Git\\bin\\bash.exe')
    expect(l.args).toEqual(['-c', 'echo hi'])
    expect(l.supportsSession).toBe(true)
    expect(l.detached).toBe(false) // no POSIX process groups on Windows
    expect(l.windowsHide).toBe(true)
  })

  it('falls back to cmd.exe /d /s /c without session support', () => {
    const l = windowsLaunch('echo hi', null, { ComSpec: 'C:\\Windows\\System32\\cmd.exe' })
    expect(l.file).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(l.args).toEqual(['/d', '/s', '/c', 'echo hi'])
    expect(l.supportsSession).toBe(false)
    expect(l.detached).toBe(false)
    expect(l.windowsHide).toBe(true)
  })

  it('keeps the command a single argv element (no injection surface)', () => {
    const command = 'echo a && del C:\\x'
    expect(windowsLaunch(command, null, {}).args).toEqual(['/d', '/s', '/c', command])
    expect(windowsLaunch(command, 'bash.exe').args).toEqual(['-c', command])
  })
})

describe('makeWindowsBackend', () => {
  it('is never sandboxed and never confines the network (honest)', () => {
    const b = makeWindowsBackend({ bashPath: null })
    expect(b.id).toBe('windows')
    expect(b.sandboxed).toBe(false)
    expect(b.confinesNetwork).toBe(false)
  })

  it('reports supportsSession from the resolved shell', () => {
    expect(makeWindowsBackend({ bashPath: 'C:\\Git\\bin\\bash.exe' }).supportsSession).toBe(true)
    expect(makeWindowsBackend({ bashPath: null }).supportsSession).toBe(false)
  })

  it('builds a launch via the resolved shell', () => {
    const b = makeWindowsBackend({ bashPath: null, env: { ComSpec: 'cmd.exe' } })
    const launch = b.buildLaunch({ command: 'dir', roots: [], allowNetwork: false, cwd: 'C:\\ws' })
    expect(launch.file).toBe('cmd.exe')
    expect(launch.args).toEqual(['/d', '/s', '/c', 'dir'])
  })
})
