import { describe, expect, it } from 'vitest'
import { UnsandboxedBackend, unsandboxedLaunch } from './unsandboxed'

describe('unsandboxedLaunch', () => {
  it('runs through /bin/bash -c, detached, on POSIX hosts', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const l = unsandboxedLaunch('echo hi', platform)
      expect(l.file).toBe('/bin/bash')
      expect(l.args).toEqual(['-c', 'echo hi'])
      expect(l.detached).toBe(true)
      expect(l.windowsHide).toBe(false)
    }
  })

  it('runs through cmd.exe, NOT detached, with the window hidden on Windows', () => {
    const l = unsandboxedLaunch('echo hi', 'win32')
    expect(l.file.toLowerCase()).toContain('cmd') // ComSpec or cmd.exe
    expect(l.args).toEqual(['/d', '/s', '/c', 'echo hi'])
    expect(l.detached).toBe(false) // no POSIX process group on Windows
    expect(l.windowsHide).toBe(true)
  })
})

describe('UnsandboxedBackend', () => {
  it('is honest that it does not confine', () => {
    expect(UnsandboxedBackend.id).toBe('none')
    expect(UnsandboxedBackend.sandboxed).toBe(false)
    expect(UnsandboxedBackend.confinesNetwork).toBe(false)
  })
})
