import { describe, it, expect } from 'vitest'
import {
  clampSidebarWidth,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH
} from './sidebar'

describe('clampSidebarWidth', () => {
  it('passes through a width already in range, rounded', () => {
    expect(clampSidebarWidth(300)).toBe(300)
    expect(clampSidebarWidth(247.6)).toBe(248)
  })

  it('clamps below the minimum up to the minimum', () => {
    expect(clampSidebarWidth(0)).toBe(SIDEBAR_MIN_WIDTH)
    expect(clampSidebarWidth(-500)).toBe(SIDEBAR_MIN_WIDTH)
    expect(clampSidebarWidth(SIDEBAR_MIN_WIDTH - 1)).toBe(SIDEBAR_MIN_WIDTH)
  })

  it('clamps above the maximum down to the maximum', () => {
    expect(clampSidebarWidth(9999)).toBe(SIDEBAR_MAX_WIDTH)
    expect(clampSidebarWidth(SIDEBAR_MAX_WIDTH + 1)).toBe(SIDEBAR_MAX_WIDTH)
  })

  it('keeps the exact boundary values', () => {
    expect(clampSidebarWidth(SIDEBAR_MIN_WIDTH)).toBe(SIDEBAR_MIN_WIDTH)
    expect(clampSidebarWidth(SIDEBAR_MAX_WIDTH)).toBe(SIDEBAR_MAX_WIDTH)
  })

  it('falls back to the default for non-finite input', () => {
    expect(clampSidebarWidth(NaN)).toBe(SIDEBAR_DEFAULT_WIDTH)
    expect(clampSidebarWidth(Infinity)).toBe(SIDEBAR_DEFAULT_WIDTH)
  })
})
