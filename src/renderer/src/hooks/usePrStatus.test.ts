import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PR_REFRESH_MS, usePrStatus } from './usePrStatus'

const pr = {
  number: 3,
  title: 't',
  state: 'OPEN',
  isDraft: false,
  url: 'https://github.com/o/r/pull/3',
  checks: 'pending',
  counts: { passing: 0, failing: 0, pending: 1 }
}

let gitPrStatus: ReturnType<typeof vi.fn>
beforeEach(() => {
  vi.useFakeTimers()
  gitPrStatus = vi.fn().mockResolvedValue({ kind: 'pr', pr })
  window.api = { gitPrStatus } as unknown as typeof window.api
})
afterEach(() => vi.useRealTimers())

const flush = (): Promise<void> => act(async () => {})

describe('usePrStatus', () => {
  it('reads the PR, then again on focus, after a run, and every few minutes', async () => {
    const { result, rerender } = renderHook((p: { running: boolean }) => usePrStatus('/ws', true, p.running), {
      initialProps: { running: false }
    })
    await flush()
    expect(result.current?.number).toBe(3)
    expect(gitPrStatus).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new Event('focus'))
    await flush()
    expect(gitPrStatus).toHaveBeenCalledTimes(2)
    rerender({ running: true })
    rerender({ running: false })
    await flush()
    expect(gitPrStatus).toHaveBeenCalledTimes(3)
    await act(async () => void vi.advanceTimersByTime(PR_REFRESH_MS - 1))
    expect(gitPrStatus).toHaveBeenCalledTimes(3)
    await act(async () => void vi.advanceTimersByTime(1))
    expect(gitPrStatus).toHaveBeenCalledTimes(4)
  })

  it('never asks for a folder without a GitHub remote, and hides the chip when there is no PR', async () => {
    const { result, rerender } = renderHook((p: { on: boolean }) => usePrStatus('/ws', p.on, false), {
      initialProps: { on: false }
    })
    await flush()
    await act(async () => void vi.advanceTimersByTime(PR_REFRESH_MS * 2))
    window.dispatchEvent(new Event('focus'))
    expect(gitPrStatus).not.toHaveBeenCalled()
    expect(result.current).toBeNull()
    gitPrStatus.mockResolvedValue({ kind: 'none' })
    rerender({ on: true })
    await flush()
    expect(result.current).toBeNull()
  })
})
