import { afterEach, describe, expect, it, vi } from 'vitest'

// The barrel resolves the host's backend lazily: selection probes bubblewrap with a
// synchronous spawn on Linux, which a process that never runs a command should not pay.
// Spy on the real selectBackend so the resolved backend is still the host's own.
const selectSpy = vi.hoisted(() => ({ calls: 0 }))
vi.mock('./select', async (importOriginal) => {
  const real = await importOriginal<typeof import('./select')>()
  return {
    ...real,
    selectBackend: (...args: Parameters<typeof real.selectBackend>) => {
      selectSpy.calls++
      return real.selectBackend(...args)
    }
  }
})

afterEach(() => {
  vi.resetModules()
  selectSpy.calls = 0
})

describe('sandbox barrel backend resolution', () => {
  it('does not select a backend when the module is imported', async () => {
    await import('./index')
    expect(selectSpy.calls).toBe(0)
  })

  it('selects once on first use and reports the same backend selectBackend picks', async () => {
    const sandbox = await import('./index')
    const id = sandbox.activeBackendId()
    expect(selectSpy.calls).toBe(1)
    // Every accessor reads the one cached backend; no further probes.
    const sandboxed = sandbox.isSandboxed()
    const session = sandbox.backendSupportsSession()
    const syntax = sandbox.backendShellSyntax()
    expect(sandbox.activeBackendId()).toBe(id)
    expect(selectSpy.calls).toBe(1)
    const { selectBackend } = await import('./select')
    const expected = selectBackend()
    expect(id).toBe(expected.id)
    expect(sandboxed).toBe(expected.sandboxed)
    expect(session).toBe(expected.supportsSession)
    expect(syntax).toBe(expected.shellSyntax)
  })
})
