import { describe, expect, it } from 'vitest'
import { sandboxAvailable, selectBackend } from './select'

// selectBackend/sandboxAvailable are tested via injected platform/exists — NEVER via
// the host-bound backend the barrel resolves at module load, which can't be re-mocked.

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

  it('falls back to the unconfined backend on windows', () => {
    const b = selectBackend({ platform: 'win32', exists: () => true })
    expect(b.id).toBe('none')
    expect(b.sandboxed).toBe(false)
  })
})
