import { describe, expect, it } from 'vitest'
import { UnsandboxedBackend, unsandboxedLaunch } from './unsandboxed'

describe('unsandboxedLaunch', () => {
  it('runs through /bin/bash -c, detached, supporting the session prelude', () => {
    const l = unsandboxedLaunch('echo hi')
    expect(l.file).toBe('/bin/bash')
    expect(l.args).toEqual(['-c', 'echo hi'])
    expect(l.detached).toBe(true)
    expect(l.windowsHide).toBe(false)
    expect(l.supportsSession).toBe(true)
  })
})

describe('UnsandboxedBackend', () => {
  it('is honest that it does not confine', () => {
    expect(UnsandboxedBackend.id).toBe('none')
    expect(UnsandboxedBackend.sandboxed).toBe(false)
    expect(UnsandboxedBackend.confinesNetwork).toBe(false)
  })
})
