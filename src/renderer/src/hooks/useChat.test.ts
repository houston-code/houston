import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AgentEvent, AgentSendRequest, ToolApprovalDecision } from '@shared/agent'
import { useChat } from './useChat'

type EventHandler = (e: AgentEvent) => void

/**
 * Install a fake `window.api` that captures the agent-event subscriber so tests
 * can drive the hook by emitting events, and records the calls the hook makes
 * back to the main process.
 */
function installApi() {
  let handler: EventHandler | null = null
  const unsubscribe = vi.fn()
  const api = {
    onAgentEvent: vi.fn((cb: EventHandler) => {
      handler = cb
      return unsubscribe
    }),
    startAgent: vi.fn((_req: AgentSendRequest) => Promise.resolve()),
    retryAgent: vi.fn((_req: unknown) => Promise.resolve()),
    cancelAgent: vi.fn((_runId: string) => Promise.resolve()),
    approveTool: vi.fn((_runId: string, _callId: string, _decision: ToolApprovalDecision) =>
      Promise.resolve()
    ),
    setAgentPolicy: vi.fn((_runId: string, _policy: string) => Promise.resolve()),
    restoreCheckpoint: vi.fn((_runId: string) => Promise.resolve(3)),
    reapplyCheckpoint: vi.fn((_runId: string) => Promise.resolve(2))
  }
  window.api = api as unknown as typeof window.api
  return {
    api,
    unsubscribe,
    /** Synchronously deliver an event to the hook's subscriber, inside `act`. */
    emit(e: AgentEvent): void {
      if (!handler) throw new Error('useChat never subscribed via onAgentEvent')
      act(() => handler!(e))
    }
  }
}

const SEND = {
  conversationId: 'c1',
  userText: 'hello',
  providerId: 'anthropic',
  model: 'claude',
  approvalPolicy: 'ask'
} as const

async function sendAndGetRunId(
  result: { current: ReturnType<typeof useChat> },
  api: ReturnType<typeof installApi>['api']
): Promise<string> {
  await act(async () => {
    await result.current.send({ ...SEND })
  })
  return api.startAgent.mock.calls[0][0].runId
}

describe('useChat', () => {
  it('appends a user item and starts the agent on send', async () => {
    const { api } = installApi()
    const { result } = renderHook(() => useChat())

    const runId = await sendAndGetRunId(result, api)

    expect(api.startAgent).toHaveBeenCalledOnce()
    expect(api.startAgent.mock.calls[0][0]).toMatchObject({
      runId,
      conversationId: 'c1',
      userText: 'hello',
      providerId: 'anthropic',
      model: 'claude',
      approvalPolicy: 'ask'
    })
    expect(result.current.running).toBe(true)
    expect(result.current.errored).toBe(false)
    expect(result.current.items).toHaveLength(1)
    expect(result.current.items[0]).toMatchObject({ kind: 'user', text: 'hello' })
  })

  it('ignores events from a stale run', async () => {
    const { api, emit } = installApi()
    const { result } = renderHook(() => useChat())
    await sendAndGetRunId(result, api)

    emit({ runId: 'stale', type: 'tool_result', callId: 'x', name: 'write_file', ok: true, output: 'ok' })

    expect(result.current.checkpoint).toBeNull()
    // The user item from send is still the only item — the stale event was dropped.
    expect(result.current.items).toHaveLength(1)
  })

  it('tracks successful write-tool results as a revertable checkpoint', async () => {
    const { api, emit } = installApi()
    const { result } = renderHook(() => useChat())
    const runId = await sendAndGetRunId(result, api)

    emit({ runId, type: 'tool_start', callId: 'a', name: 'write_file', args: {} })
    emit({ runId, type: 'tool_result', callId: 'a', name: 'write_file', ok: true, output: 'wrote' })
    emit({ runId, type: 'tool_start', callId: 'b', name: 'edit_file', args: {} })
    emit({ runId, type: 'tool_result', callId: 'b', name: 'edit_file', ok: true, output: 'edited' })

    expect(result.current.checkpoint).toEqual({ runId, files: 2, reverted: false })
  })

  it('does not count reads or failed writes toward the checkpoint', async () => {
    const { api, emit } = installApi()
    const { result } = renderHook(() => useChat())
    const runId = await sendAndGetRunId(result, api)

    emit({ runId, type: 'tool_result', callId: 'r', name: 'read_file', ok: true, output: 'data' })
    emit({ runId, type: 'tool_result', callId: 'w', name: 'write_file', ok: false, output: 'boom' })

    expect(result.current.checkpoint).toBeNull()
  })

  it('applies usage events: sets totals, keeps prior values on falsy fields, drops stale', async () => {
    const { api, emit } = installApi()
    const { result } = renderHook(() => useChat())
    const runId = await sendAndGetRunId(result, api)

    // The event carries cumulative totals, so the hook sets (not sums) them.
    emit({ runId, type: 'usage', inputTokens: 1000, outputTokens: 200, cost: 0.02 })
    expect(result.current.usage).toEqual({ context: 1000, output: 200, cost: 0.02 })

    // A falsy field falls back to the previous value (the `|| prev` chain).
    emit({ runId, type: 'usage', inputTokens: 0, outputTokens: 350, cost: 0 })
    expect(result.current.usage).toEqual({ context: 1000, output: 350, cost: 0.02 })

    // Usage from a stale run is dropped by the runId guard.
    emit({ runId: 'stale', type: 'usage', inputTokens: 9999, outputTokens: 9999, cost: 9 })
    expect(result.current.usage).toEqual({ context: 1000, output: 350, cost: 0.02 })
  })

  it('stops running on done and flags errors on error', async () => {
    const { api, emit } = installApi()
    const { result } = renderHook(() => useChat())
    const runId = await sendAndGetRunId(result, api)
    expect(result.current.running).toBe(true)

    emit({ runId, type: 'done', stopReason: 'end_turn' })
    expect(result.current.running).toBe(false)
    expect(result.current.errored).toBe(false)

    // A later run that errors flips `errored` and clears `running`.
    const runId2 = await sendAndGetRunId2(result, api)
    emit({ runId: runId2, type: 'error', message: 'kaboom' })
    expect(result.current.running).toBe(false)
    expect(result.current.errored).toBe(true)
  })

  it('retry re-runs the turn with a fresh runId, adds no user item, and clears errored', async () => {
    const { api, emit } = installApi()
    const { result } = renderHook(() => useChat())
    const runId = await sendAndGetRunId(result, api)
    emit({ runId, type: 'error', message: 'boom' })
    expect(result.current.errored).toBe(true)
    const itemsBefore = result.current.items.length

    await act(async () => {
      await result.current.retry({
        conversationId: 'c1',
        providerId: 'anthropic',
        model: 'claude',
        approvalPolicy: 'ask'
      })
    })

    expect(api.retryAgent).toHaveBeenCalledOnce()
    const arg = api.retryAgent.mock.calls[0][0] as { runId: string; conversationId: string }
    expect(arg).toMatchObject({
      conversationId: 'c1',
      providerId: 'anthropic',
      model: 'claude',
      approvalPolicy: 'ask'
    })
    expect(typeof arg.runId).toBe('string')
    expect(arg.runId).not.toBe(runId) // a new run, not the failed one
    expect(result.current.running).toBe(true)
    expect(result.current.errored).toBe(false)
    // retry must not append a new user message (the turn is already persisted).
    expect(result.current.items).toHaveLength(itemsBefore)
  })

  it('routes cancel, approve, and setPolicy to the active run', async () => {
    const { api } = installApi()
    const { result } = renderHook(() => useChat())
    const runId = await sendAndGetRunId(result, api)

    act(() => result.current.approve('call-1', 'always'))
    expect(api.approveTool).toHaveBeenCalledWith(runId, 'call-1', 'always')

    act(() => result.current.setPolicy('full-auto'))
    expect(api.setAgentPolicy).toHaveBeenCalledWith(runId, 'full-auto')

    act(() => result.current.cancel())
    expect(api.cancelAgent).toHaveBeenCalledWith(runId)
  })

  it('setPolicy is a no-op when no run is active', () => {
    const { api } = installApi()
    const { result } = renderHook(() => useChat())

    act(() => result.current.setPolicy('plan'))
    expect(api.setAgentPolicy).not.toHaveBeenCalled()
  })

  it('reverts and re-applies a checkpoint through the bridge', async () => {
    const { api, emit } = installApi()
    const { result } = renderHook(() => useChat())
    const runId = await sendAndGetRunId(result, api)
    emit({ runId, type: 'tool_result', callId: 'a', name: 'write_file', ok: true, output: 'wrote' })

    let restored = 0
    await act(async () => {
      restored = await result.current.revertCheckpoint()
    })
    expect(restored).toBe(3)
    expect(api.restoreCheckpoint).toHaveBeenCalledWith(runId)
    expect(result.current.checkpoint).toMatchObject({ runId, reverted: true })

    let reapplied = 0
    await act(async () => {
      reapplied = await result.current.reapplyCheckpoint()
    })
    expect(reapplied).toBe(2)
    expect(api.reapplyCheckpoint).toHaveBeenCalledWith(runId)
    expect(result.current.checkpoint).toMatchObject({ runId, reverted: false })
  })

  it('reset clears the transcript and seeds usage', async () => {
    const { api } = installApi()
    const { result } = renderHook(() => useChat())
    await sendAndGetRunId(result, api)

    act(() => result.current.reset([], { context: 10, output: 5, cost: 0.01 }))

    expect(result.current.items).toEqual([])
    expect(result.current.running).toBe(false)
    expect(result.current.usage).toEqual({ context: 10, output: 5, cost: 0.01 })
    expect(result.current.checkpoint).toBeNull()
  })

  it('unsubscribes from agent events on unmount', () => {
    const { unsubscribe } = installApi()
    const { unmount } = renderHook(() => useChat())
    expect(unsubscribe).not.toHaveBeenCalled()
    unmount()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})

/** A second send within one test, using the next recorded startAgent call. */
async function sendAndGetRunId2(
  result: { current: ReturnType<typeof useChat> },
  api: ReturnType<typeof installApi>['api']
): Promise<string> {
  await act(async () => {
    await result.current.send({ ...SEND })
  })
  return api.startAgent.mock.calls[1][0].runId
}
