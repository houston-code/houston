import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDelayedFlag } from './useDelayedFlag'

describe('useDelayedFlag', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('turns true only after the flag has held for the delay', () => {
    const { result } = renderHook(({ on }) => useDelayedFlag(on, 2000), { initialProps: { on: true } })
    expect(result.current).toBe(false)
    act(() => vi.advanceTimersByTime(1999))
    expect(result.current).toBe(false)
    act(() => vi.advanceTimersByTime(1))
    expect(result.current).toBe(true)
  })

  it('turns false at once and restarts the wait next time', () => {
    const { result, rerender } = renderHook(({ on }) => useDelayedFlag(on, 2000), {
      initialProps: { on: true }
    })
    act(() => vi.advanceTimersByTime(2000))
    rerender({ on: false })
    expect(result.current).toBe(false)
    rerender({ on: true })
    expect(result.current).toBe(false)
    act(() => vi.advanceTimersByTime(2000))
    expect(result.current).toBe(true)
  })
})
