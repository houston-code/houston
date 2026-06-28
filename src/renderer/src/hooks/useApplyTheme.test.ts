import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useApplyTheme } from './useApplyTheme'

afterEach(() => {
  delete document.documentElement.dataset.theme
  vi.unstubAllGlobals()
})

describe('useApplyTheme', () => {
  it('applies an explicit theme to the document root', () => {
    renderHook(() => useApplyTheme('light'))
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('re-applies when the theme changes', () => {
    const { rerender } = renderHook(({ t }: { t: 'dark' | 'light' }) => useApplyTheme(t), {
      initialProps: { t: 'dark' }
    })
    expect(document.documentElement.dataset.theme).toBe('dark')
    rerender({ t: 'light' })
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('follows the OS preference and tracks changes while on "system"', () => {
    let prefersLight = true
    const listeners = new Set<() => void>()
    const mql = {
      get matches() {
        return prefersLight
      },
      addEventListener: (_: string, cb: () => void) => listeners.add(cb),
      removeEventListener: (_: string, cb: () => void) => listeners.delete(cb)
    }
    vi.stubGlobal('matchMedia', vi.fn(() => mql))

    const { unmount } = renderHook(() => useApplyTheme('system'))
    expect(document.documentElement.dataset.theme).toBe('light')

    // The OS flips to a dark preference; the registered listener re-resolves.
    prefersLight = false
    listeners.forEach((cb) => cb())
    expect(document.documentElement.dataset.theme).toBe('dark')

    // Unmounting detaches the listener so it can't fire after teardown.
    unmount()
    expect(listeners.size).toBe(0)
  })
})
