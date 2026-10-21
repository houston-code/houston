import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BackgroundShellInfo } from '@shared/agent'
import { useBackgroundShells } from './useBackgroundShells'

function shell(id: string, over: Partial<BackgroundShellInfo> = {}): BackgroundShellInfo {
  return { id, command: `cmd ${id}`, running: true, exitCode: null, startedAt: 1, exitedAt: null, ...over }
}

/** Install a fake `window.api` exposing just the two methods this hook touches. */
function installApi(initial: BackgroundShellInfo[] = []) {
  let handler: ((list: BackgroundShellInfo[]) => void) | null = null
  const unsubscribe = vi.fn()
  const api = {
    getBackgroundShells: vi.fn(() => Promise.resolve(initial)),
    onShellsChanged: vi.fn((cb: (list: BackgroundShellInfo[]) => void) => {
      handler = cb
      return unsubscribe
    })
  }
  window.api = api as unknown as typeof window.api
  return {
    api,
    unsubscribe,
    push(list: BackgroundShellInfo[]): void {
      if (!handler) throw new Error('useBackgroundShells never subscribed')
      act(() => handler!(list))
    }
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useBackgroundShells', () => {
  it('re-polls only while asked to, and stops when the interval goes to 0', async () => {
    vi.useFakeTimers()
    try {
      const { api } = installApi([shell('s1')])
      const { rerender } = renderHook(({ ms }) => useBackgroundShells(ms), { initialProps: { ms: 0 } })
      await act(async () => {
        vi.advanceTimersByTime(20_000)
      })
      expect(api.getBackgroundShells).toHaveBeenCalledTimes(1) // the seed only
      rerender({ ms: 5000 })
      await act(async () => {
        vi.advanceTimersByTime(10_000)
      })
      expect(api.getBackgroundShells).toHaveBeenCalledTimes(3)
      rerender({ ms: 0 })
      await act(async () => {
        vi.advanceTimersByTime(20_000)
      })
      expect(api.getBackgroundShells).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('seeds from the one-shot query', async () => {
    installApi([shell('s1'), shell('s2')])
    const { result } = renderHook(() => useBackgroundShells())
    await waitFor(() => expect(result.current.map((s) => s.id)).toEqual(['s1', 's2']))
  })

  it('tracks broadcast changes and unsubscribes on unmount', async () => {
    const { push, unsubscribe } = installApi([])
    const { result, unmount } = renderHook(() => useBackgroundShells())

    push([shell('s1', { running: false, exitCode: 0, exitedAt: 9 })])
    await waitFor(() => expect(result.current[0]?.exitCode).toBe(0))

    push([])
    await waitFor(() => expect(result.current).toHaveLength(0))

    unmount()
    expect(unsubscribe).toHaveBeenCalled()
  })

  it('no-ops when the bridge is unavailable', () => {
    window.api = {} as unknown as typeof window.api
    const { result } = renderHook(() => useBackgroundShells())
    expect(result.current).toHaveLength(0)
  })
})
