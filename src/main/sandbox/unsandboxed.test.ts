import { describe, expect, it } from 'vitest'
import { UnsandboxedBackend, makeUnsandboxedBackend, unsandboxedLaunch } from './unsandboxed'

describe('unsandboxedLaunch', () => {
  it('runs through bash -c, detached, supporting the session prelude (defaults)', () => {
    const l = unsandboxedLaunch('echo hi')
    expect(l.file).toBe('/bin/bash')
    expect(l.args).toEqual(['-c', 'echo hi'])
    expect(l.detached).toBe(true)
    expect(l.windowsHide).toBe(false)
    expect(l.supportsSession).toBe(true)
  })

  it('honors an explicit shell and supportsSession (e.g. the /bin/sh fallback)', () => {
    const l = unsandboxedLaunch('echo hi', '/bin/sh', false)
    expect(l.file).toBe('/bin/sh')
    expect(l.args).toEqual(['-c', 'echo hi'])
    expect(l.supportsSession).toBe(false)
  })
})

describe('makeUnsandboxedBackend', () => {
  it('resolves a real bash and keeps the session prelude when bash exists', () => {
    const b = makeUnsandboxedBackend((p) => p === '/bin/bash')
    expect(b.supportsSession).toBe(true)
    const l = b.buildLaunch({ command: 'ls', roots: [], allowNetwork: false, cwd: '/tmp' })
    expect(l.file).toBe('/bin/bash')
    expect(l.supportsSession).toBe(true)
  })

  it('finds bash outside /bin (e.g. /usr/bin/bash) when /bin/bash is absent', () => {
    const b = makeUnsandboxedBackend((p) => p === '/usr/bin/bash')
    const l = b.buildLaunch({ command: 'ls', roots: [], allowNetwork: false, cwd: '/tmp' })
    expect(l.file).toBe('/usr/bin/bash')
    expect(l.supportsSession).toBe(true)
  })

  it('falls back to /bin/sh and drops the session when no bash exists', () => {
    const b = makeUnsandboxedBackend(() => false)
    expect(b.supportsSession).toBe(false)
    const l = b.buildLaunch({ command: 'ls', roots: [], allowNetwork: false, cwd: '/tmp' })
    expect(l.file).toBe('/bin/sh')
    expect(l.supportsSession).toBe(false)
  })
})

describe('UnsandboxedBackend', () => {
  it('is honest that it does not confine', () => {
    expect(UnsandboxedBackend.id).toBe('none')
    expect(UnsandboxedBackend.sandboxed).toBe(false)
    expect(UnsandboxedBackend.confinesNetwork).toBe(false)
  })
})
