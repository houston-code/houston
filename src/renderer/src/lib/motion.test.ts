import { afterEach, describe, expect, it, vi } from 'vitest'
import { scrollBehavior } from './motion'

function stubReducedMotion(reduce: boolean): ReturnType<typeof vi.fn> {
  const matchMedia = vi.fn((query: string) => ({
    matches: reduce && query === '(prefers-reduced-motion: reduce)',
    media: query
  }))
  vi.stubGlobal('matchMedia', matchMedia)
  return matchMedia
}

describe('scrollBehavior', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('scrolls smoothly by default', () => {
    stubReducedMotion(false)
    expect(scrollBehavior()).toBe('smooth')
  })

  it('jumps instantly when the OS prefers reduced motion', () => {
    const matchMedia = stubReducedMotion(true)
    expect(scrollBehavior()).toBe('auto')
    expect(matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)')
  })

  it('reads the preference on every call, so a change in the OS setting applies at once', () => {
    stubReducedMotion(false)
    expect(scrollBehavior()).toBe('smooth')
    stubReducedMotion(true)
    expect(scrollBehavior()).toBe('auto')
  })

  it('falls back to smooth where matchMedia is missing', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(scrollBehavior()).toBe('smooth')
  })
})
