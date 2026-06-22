import { describe, expect, it } from 'vitest'
import { isNearBottom } from './scroll'

describe('isNearBottom', () => {
  it('is pinned when scrolled to the exact bottom', () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 })).toBe(true)
  })

  it('is pinned when within the threshold of the bottom', () => {
    // 50px from the bottom, default threshold 80
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 550, clientHeight: 400 })).toBe(true)
  })

  it('is not pinned when scrolled up beyond the threshold', () => {
    // 300px from the bottom
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 300, clientHeight: 400 })).toBe(false)
  })

  it('treats the threshold edge as pinned', () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 520, clientHeight: 400 })).toBe(true) // exactly 80
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 519, clientHeight: 400 })).toBe(false) // 81
  })

  it('respects a custom threshold', () => {
    const metrics = { scrollHeight: 1000, scrollTop: 400, clientHeight: 400 } // 200 from bottom
    expect(isNearBottom(metrics, 100)).toBe(false)
    expect(isNearBottom(metrics, 250)).toBe(true)
  })

  it('is pinned when content fits without scrolling', () => {
    expect(isNearBottom({ scrollHeight: 300, scrollTop: 0, clientHeight: 400 })).toBe(true)
  })
})
