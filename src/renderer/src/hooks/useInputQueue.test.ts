import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { QueueAddRequest, QueuedInputMeta } from '@shared/queue'
import { useInputQueue } from './useInputQueue'

type QueueChangedHandler = (p: { conversationId: string; items: QueuedInputMeta[] }) => void

/** Fake `window.api` exposing just the queue surface, with drivers for the test. */
function installApi(initial: Record<string, QueuedInputMeta[]> = {}) {
  let onChanged: QueueChangedHandler | null = null
  const api = {
    listQueue: vi.fn((cid: string) => Promise.resolve(initial[cid] ?? [])),
    queueInput: vi.fn((req: QueueAddRequest) =>
      Promise.resolve([{ id: 'q-new', text: req.userText, imageCount: req.images?.length ?? 0 }])
    ),
    dequeueInput: vi.fn((_cid: string, _id: string) => Promise.resolve([] as QueuedInputMeta[])),
    clearQueue: vi.fn((_cid: string) => Promise.resolve([] as QueuedInputMeta[])),
    flushQueue: vi.fn((_cid: string) => Promise.resolve()),
    onQueueChanged: vi.fn((cb: QueueChangedHandler) => {
      onChanged = cb
      return () => {}
    })
  }
  window.api = api as unknown as typeof window.api
  return {
    api,
    push(payload: { conversationId: string; items: QueuedInputMeta[] }): void {
      if (!onChanged) throw new Error('useInputQueue never subscribed via onQueueChanged')
      act(() => onChanged!(payload))
    }
  }
}

const ENQUEUE = {
  providerId: 'anthropic',
  model: 'claude',
  approvalPolicy: 'ask'
} as const

describe('useInputQueue', () => {
  it('loads the open conversation’s queue on mount', async () => {
    const { api } = installApi({ c1: [{ id: 'a', text: 'pending', imageCount: 0 }] })
    const { result } = renderHook(() => useInputQueue('c1'))

    expect(api.listQueue).toHaveBeenCalledWith('c1')
    await waitFor(() => expect(result.current.queued).toEqual([{ id: 'a', text: 'pending', imageCount: 0 }]))
  })

  it('enqueues with full send settings and reflects the returned queue', async () => {
    const { api } = installApi()
    const { result } = renderHook(() => useInputQueue('c1'))

    act(() => result.current.enqueue({ text: 'do B', ...ENQUEUE }))

    expect(api.queueInput).toHaveBeenCalledWith({
      conversationId: 'c1',
      userText: 'do B',
      images: undefined,
      providerId: 'anthropic',
      model: 'claude',
      approvalPolicy: 'ask'
    })
    await waitFor(() => expect(result.current.queued).toEqual([{ id: 'q-new', text: 'do B', imageCount: 0 }]))
  })

  // A steer the run declines falls back to queuing, resolving async — by which time
  // the user may have opened another chat. An explicit target keeps the text in the
  // conversation it was typed in, and the open conversation's bar is left untouched.
  it('queues into an explicit target conversation, not the open one', async () => {
    const { api } = installApi()
    const { result } = renderHook(() => useInputQueue('open-conv'))

    act(() => result.current.enqueue({ text: 'late steer', conversationId: 'origin-conv', ...ENQUEUE }))

    expect(api.queueInput).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'origin-conv', userText: 'late steer' })
    )
    // The bar reflects the OPEN conversation, so queuing elsewhere must not change it.
    await waitFor(() => expect(api.queueInput).toHaveBeenCalled())
    expect(result.current.queued).toEqual([])
  })

  it('remove and clear route to the bridge and update the bar', async () => {
    const { api } = installApi({ c1: [{ id: 'a', text: 'x', imageCount: 0 }] })
    const { result } = renderHook(() => useInputQueue('c1'))
    await waitFor(() => expect(result.current.queued).toHaveLength(1))

    act(() => result.current.remove('a'))
    expect(api.dequeueInput).toHaveBeenCalledWith('c1', 'a')
    await waitFor(() => expect(result.current.queued).toEqual([]))

    act(() => result.current.clear())
    expect(api.clearQueue).toHaveBeenCalledWith('c1')
  })

  it('flush dispatches the open conversation’s queue via the bridge', async () => {
    const { api } = installApi({ c1: [{ id: 'a', text: 'x', imageCount: 0 }] })
    const { result } = renderHook(() => useInputQueue('c1'))
    await waitFor(() => expect(result.current.queued).toHaveLength(1))

    act(() => result.current.flush())
    expect(api.flushQueue).toHaveBeenCalledWith('c1')
  })

  it('flush is a no-op with no conversation open', () => {
    const { api } = installApi()
    const { result } = renderHook(() => useInputQueue(null))
    act(() => result.current.flush())
    expect(api.flushQueue).not.toHaveBeenCalled()
  })

  it('applies a pushed change for the open conversation and ignores others', async () => {
    const { api, push } = installApi()
    const { result } = renderHook(() => useInputQueue('c1'))
    // Let the initial (empty) load settle so it can't overwrite a later push.
    await waitFor(() => expect(api.listQueue).toHaveBeenCalledWith('c1'))
    await act(async () => {})

    push({ conversationId: 'c1', items: [{ id: 'z', text: 'flushed-soon', imageCount: 0 }] })
    await waitFor(() => expect(result.current.queued).toEqual([{ id: 'z', text: 'flushed-soon', imageCount: 0 }]))

    // A change for a different conversation must not touch this bar.
    push({ conversationId: 'other', items: [] })
    expect(result.current.queued).toEqual([{ id: 'z', text: 'flushed-soon', imageCount: 0 }])

    // The main process empties the queue on auto-flush.
    push({ conversationId: 'c1', items: [] })
    await waitFor(() => expect(result.current.queued).toEqual([]))
  })

  it('reloads when the conversation changes and empties when there is none', async () => {
    const { api } = installApi({ c1: [{ id: 'a', text: '1', imageCount: 0 }], c2: [{ id: 'b', text: '2', imageCount: 0 }] })
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => useInputQueue(id), {
      initialProps: { id: 'c1' as string | null }
    })
    await waitFor(() => expect(result.current.queued).toEqual([{ id: 'a', text: '1', imageCount: 0 }]))

    rerender({ id: 'c2' })
    expect(api.listQueue).toHaveBeenCalledWith('c2')
    await waitFor(() => expect(result.current.queued).toEqual([{ id: 'b', text: '2', imageCount: 0 }]))

    rerender({ id: null })
    await waitFor(() => expect(result.current.queued).toEqual([]))
  })
})
