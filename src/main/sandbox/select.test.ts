import { describe, expect, it } from 'vitest'
import { sandboxAvailable, selectBackend, selectBackendAsync } from './select'

// selectBackend/sandboxAvailable are tested via injected platform/exists — NEVER via
// the host-bound backend the barrel resolves on first use (index.test.ts covers that).

describe('sandboxAvailable', () => {
  it('is true on macOS when sandbox-exec is present', () => {
    expect(sandboxAvailable({ platform: 'darwin', exists: () => true })).toBe(true)
  })

  it('is false on macOS when sandbox-exec is missing', () => {
    expect(sandboxAvailable({ platform: 'darwin', exists: () => false })).toBe(false)
  })

  it('on linux, reflects whether bubblewrap is usable (the probe)', () => {
    expect(sandboxAvailable({ platform: 'linux', bwrapUsable: () => true })).toBe(true)
    expect(sandboxAvailable({ platform: 'linux', bwrapUsable: () => false })).toBe(false)
  })

  it('is false on windows', () => {
    expect(sandboxAvailable({ platform: 'win32', exists: () => true })).toBe(false)
  })
})

describe('selectBackend', () => {
  it('picks the Seatbelt backend on macOS with sandbox-exec present', () => {
    const b = selectBackend({ platform: 'darwin', exists: () => true })
    expect(b.id).toBe('seatbelt')
    expect(b.sandboxed).toBe(true)
  })

  it('falls back to the unconfined backend on macOS without sandbox-exec', () => {
    const b = selectBackend({ platform: 'darwin', exists: () => false })
    expect(b.id).toBe('none')
    expect(b.sandboxed).toBe(false)
  })

  it('picks the bubblewrap backend on linux when bwrap is usable', () => {
    const b = selectBackend({ platform: 'linux', bwrapUsable: () => true })
    expect(b.id).toBe('bubblewrap')
    expect(b.sandboxed).toBe(true)
  })

  it('falls back to the unconfined backend on linux when bwrap is NOT usable', () => {
    const b = selectBackend({ platform: 'linux', bwrapUsable: () => false })
    expect(b.id).toBe('none')
    expect(b.sandboxed).toBe(false)
  })

  it('picks the (unconfined) Windows backend on windows', () => {
    const b = selectBackend({ platform: 'win32', exists: () => true })
    expect(b.id).toBe('windows')
    expect(b.sandboxed).toBe(false)
  })
})

describe('selectBackendAsync', () => {
  it('decides on linux exactly as selectBackend does for the same probe answer', async () => {
    for (const usable of [true, false]) {
      const b = await selectBackendAsync({ platform: 'linux', bwrapUsableAsync: async () => usable })
      expect(b).toBe(selectBackend({ platform: 'linux', bwrapUsable: () => usable }))
    }
    expect((await selectBackendAsync({ platform: 'linux', bwrapUsableAsync: async () => false })).sandboxed).toBe(false)
  })

  it('never probes bubblewrap off linux', async () => {
    const probe = async (): Promise<boolean> => {
      throw new Error('probed')
    }
    for (const platform of ['darwin', 'win32', 'freebsd'] as const) {
      const b = await selectBackendAsync({ platform, exists: () => true, bwrapUsableAsync: probe })
      expect(b).toBe(selectBackend({ platform, exists: () => true }))
    }
  })
})
