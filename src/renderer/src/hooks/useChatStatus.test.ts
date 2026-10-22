import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatStatusMap } from '@shared/chatStatus'
import { useChatStatus } from './useChatStatus'

/**
 * Install a fake `window.api` exposing just the two methods this hook touches.
 * Returns a pusher for broadcast updates and the unsubscribe spy.
 */
function installApi(initial: ChatStatusMap = {}) {
  let handler: ((s: ChatStatusMap) => void) | null = null
  const unsubscribe = vi.fn()
  const api = {
    getChatStatus: vi.fn(() => Promise.resolve(initial)),
    onChatStatusChanged: vi.fn((cb: (s: ChatStatusMap) => void) => {
      handler = cb
      return unsubscribe
    })
  }
  window.api = api as unknown as typeof window.api
  return {
    unsubscribe,
    push(s: ChatStatusMap): void {
      if (!handler) throw new Error('useChatStatus never subscribed')
      act(() => handler!(s))
    }
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useChatStatus', () => {
  it('seeds from the one-shot query', async () => {
    installApi({ a: { running: true, pending: [] } })
    const { result } = renderHook(() => useChatStatus())
    await waitFor(() => expect(result.current.a?.running).toBe(true))
    expect(result.current.b).toBeUndefined()
  })

  it('tracks broadcast changes and unsubscribes on unmount', async () => {
    const { push, unsubscribe } = installApi({})
    const { result, unmount } = renderHook(() => useChatStatus())

    push({ x: { running: true, pending: [{ kind: 'approval', label: 'run_shell' }] } })
    await waitFor(() => expect(result.current.x?.pending).toHaveLength(1))

    push({})
    await waitFor(() => expect(result.current.x).toBeUndefined())

    unmount()
    expect(unsubscribe).toHaveBeenCalled()
  })

  it('keeps a broadcast that arrives before the seed query resolves', async () => {
    let resolveSeed!: (s: ChatStatusMap) => void
    let handler: ((s: ChatStatusMap) => void) | null = null
    window.api = {
      getChatStatus: vi.fn(() => new Promise<ChatStatusMap>((r) => (resolveSeed = r))),
      onChatStatusChanged: vi.fn((cb: (s: ChatStatusMap) => void) => {
        handler = cb
        return () => {}
      })
    } as unknown as typeof window.api
    const { result } = renderHook(() => useChatStatus())
    act(() => handler!({ a: { running: true, pending: [{ kind: 'question' }] } }))
    // The stale seed (taken before the prompt) resolves afterwards.
    await act(async () => resolveSeed({ a: { running: true, pending: [] } }))
    expect(result.current.a?.pending).toHaveLength(1)
  })

  it('no-ops when the bridge is unavailable', () => {
    window.api = {} as unknown as typeof window.api
    const { result } = renderHook(() => useChatStatus())
    expect(result.current).toEqual({})
  })
})
