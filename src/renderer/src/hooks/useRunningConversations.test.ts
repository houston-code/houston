import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRunningConversations } from './useRunningConversations'

/**
 * Install a fake `window.api` exposing just the two methods this hook touches.
 * Returns the captured onRunsChanged callback so tests can push updates, and the
 * unsubscribe spy so teardown can be asserted.
 */
function installApi(initial: string[] = []) {
  let handler: ((ids: string[]) => void) | null = null
  const unsubscribe = vi.fn()
  const api = {
    getRunningConversations: vi.fn(() => Promise.resolve(initial)),
    onRunsChanged: vi.fn((cb: (ids: string[]) => void) => {
      handler = cb
      return unsubscribe
    })
  }
  window.api = api as unknown as typeof window.api
  return {
    api,
    unsubscribe,
    push(ids: string[]): void {
      if (!handler) throw new Error('useRunningConversations never subscribed')
      act(() => handler!(ids))
    }
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useRunningConversations', () => {
  it('seeds from the one-shot query', async () => {
    installApi(['a', 'b'])
    const { result } = renderHook(() => useRunningConversations())
    await waitFor(() => expect(result.current.has('a')).toBe(true))
    expect(result.current.has('b')).toBe(true)
    expect(result.current.has('c')).toBe(false)
  })

  it('tracks broadcast changes and unsubscribes on unmount', async () => {
    const { push, unsubscribe } = installApi([])
    const { result, unmount } = renderHook(() => useRunningConversations())

    push(['x'])
    await waitFor(() => expect(result.current.has('x')).toBe(true))

    push([])
    await waitFor(() => expect(result.current.has('x')).toBe(false))

    unmount()
    expect(unsubscribe).toHaveBeenCalled()
  })

  it('no-ops when the bridge is unavailable', () => {
    window.api = {} as unknown as typeof window.api
    const { result } = renderHook(() => useRunningConversations())
    expect(result.current.size).toBe(0)
  })
})
