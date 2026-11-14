import { afterEach, describe, expect, it, vi } from 'vitest'
import { prefersReducedMotion, scrollBehavior } from './motion'
import { scrollRangeIntoView } from './transcriptFind'

function setReduced(reduce: boolean | 'throws'): void {
  window.matchMedia = vi.fn((q: string) => {
    if (reduce === 'throws') throw new Error('unsupported')
    return { matches: reduce && q === '(prefers-reduced-motion: reduce)', media: q } as MediaQueryList
  }) as unknown as typeof window.matchMedia
}

describe('motion', () => {
  const original = window.matchMedia
  afterEach(() => {
    window.matchMedia = original
  })

  it('scrolls smoothly unless the system asks for reduced motion', () => {
    setReduced(false)
    expect(prefersReducedMotion()).toBe(false)
    expect(scrollBehavior()).toBe('smooth')
    setReduced(true)
    expect(prefersReducedMotion()).toBe(true)
    expect(scrollBehavior()).toBe('auto')
  })

  it('falls back to smooth when the preference cannot be read', () => {
    setReduced('throws')
    expect(scrollBehavior()).toBe('smooth')
  })

  it('jumps straight to a find match under reduced motion', () => {
    setReduced(true)
    const el = document.createElement('p')
    el.textContent = 'needle'
    document.body.append(el)
    const spy = vi.fn()
    el.scrollIntoView = spy
    const range = document.createRange()
    range.selectNodeContents(el.firstChild as Text)
    scrollRangeIntoView(range)
    expect(spy).toHaveBeenCalledWith({ block: 'center', behavior: 'auto' })
    el.remove()
  })
})
