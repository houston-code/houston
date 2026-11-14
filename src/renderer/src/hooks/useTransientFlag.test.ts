import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useTransientFlag } from './useTransientFlag'

afterEach(() => vi.useRealTimers())

describe('useTransientFlag', () => {
  it('turns on when shown and off after the wait, which showing again restarts', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useTransientFlag(1000))
    expect(result.current[0]).toBe(false)
    act(() => result.current[1]())
    expect(result.current[0]).toBe(true)
    act(() => vi.advanceTimersByTime(600))
    act(() => result.current[1]())
    act(() => vi.advanceTimersByTime(600))
    expect(result.current[0]).toBe(true)
    act(() => vi.advanceTimersByTime(400))
    expect(result.current[0]).toBe(false)
  })

  it('leaves no timer running once its component unmounts', () => {
    vi.useFakeTimers()
    const { result, unmount } = renderHook(() => useTransientFlag(1000))
    act(() => result.current[1]())
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
