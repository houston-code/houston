import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, AgentSendRequest, AgentStartResult, ToolApprovalDecision } from '@shared/agent'
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
    startAgent: vi.fn((_req: AgentSendRequest): Promise<AgentStartResult | void> => Promise.resolve()),
    retryAgent: vi.fn((_req: unknown) => Promise.resolve()),
    cancelAgent: vi.fn((_runId: string) => Promise.resolve()),
    approveTool: vi.fn((_runId: string, _callId: string, _decision: ToolApprovalDecision, _note?: string) =>
      Promise.resolve()
    ),
    answerQuestion: vi.fn((_runId: string, _callId: string, _answer: string) => Promise.resolve()),
    setAgentPolicy: vi.fn((_runId: string, _policy: string) => Promise.resolve()),
    setAgentEffort: vi.fn((_runId: string, _effort: string) => Promise.resolve()),
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

  it('passes a first-party prompt tag to the bubble and to main', async () => {
    const { api } = installApi()
    const { result } = renderHook(() => useChat())
    const invokedAs = { kind: 'command', label: '/review', typed: '/review' } as const

    await act(async () => {
      await result.current.send({ ...SEND, userText: 'Review my changes…', invokedAs })
    })

    expect(api.startAgent.mock.calls[0][0]).toMatchObject({ userText: 'Review my changes…', invokedAs })
    expect(result.current.items[0]).toMatchObject({ kind: 'user', text: 'Review my changes…', invokedAs })
  })

  it('clears the running state when startAgent rejects (no orphan Stop button)', async () => {
    const { api } = installApi()
    api.startAgent.mockRejectedValueOnce(new Error('bridge down'))
    const { result } = renderHook(() => useChat())

    await act(async () => {
      await result.current.send({ ...SEND })
    })

    expect(result.current.running).toBe(false)
    expect(result.current.errored).toBe(true)
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

  it('counts every file-writing tool toward the checkpoint, not only write_file and edit_file', async () => {
    const { api, emit } = installApi()
    const { result } = renderHook(() => useChat())
    const runId = await sendAndGetRunId(result, api)

    emit({ runId, type: 'tool_result', callId: 'm', name: 'multi_edit', ok: true, output: 'edited' })
    emit({ runId, type: 'tool_result', callId: 'p', name: 'apply_patch', ok: true, output: 'patched' })
    emit({ runId, type: 'tool_result', callId: 'n', name: 'notebook_edit', ok: true, output: 'cell' })

    expect(result.current.checkpoint).toEqual({ runId, files: 3, reverted: false })
  })

  it("takes the main process's file count, which sees every file a patch touched", async () => {
    const { api, emit } = installApi()
    const getCheckpoint = vi.fn((_conv: string) => Promise.resolve({ runId, files: 3, reverted: false }))
    Object.assign(api, { getCheckpoint })
    const { result } = renderHook(() => useChat('c1'))
    const runId = await sendAndGetRunId(result, api)

    emit({ runId, type: 'tool_result', callId: 'p', name: 'apply_patch', ok: true, output: 'patched' })
    await act(async () => {})

    expect(getCheckpoint).toHaveBeenCalledWith('c1')
    expect(result.current.checkpoint).toEqual({ runId, files: 3, reverted: false })
  })

  it("shows a writable subagent's edits, which only the main process can count", async () => {
    const { api, emit } = installApi()
    let files = 0
    Object.assign(api, {
      getCheckpoint: vi.fn(() => Promise.resolve(files ? { runId, files, reverted: false } : null))
    })
    const { result } = renderHook(() => useChat('c1'))
    const runId = await sendAndGetRunId(result, api)

    // A subagent that changed nothing leaves no checkpoint...
    emit({ runId, type: 'tool_result', callId: 's1', name: 'dispatch_writable_agent', ok: true, output: 'report' })
    await act(async () => {})
    expect(result.current.checkpoint).toBeNull()

    // ...one that edited two files shows them.
    files = 2
    emit({ runId, type: 'tool_result', callId: 's2', name: 'dispatch_writable_agent', ok: true, output: 'report' })
    await act(async () => {})
    expect(result.current.checkpoint).toEqual({ runId, files: 2, reverted: false })
  })

  it("ignores a late checkpoint answer once another turn has started", async () => {
    const { api, emit } = installApi()
    let answer: (cp: { runId: string; files: number; reverted: boolean }) => void = () => {}
    Object.assign(api, {
      getCheckpoint: vi.fn(() => new Promise((resolve) => (answer = resolve)))
    })
    const { result } = renderHook(() => useChat('c1'))
    const runId = await sendAndGetRunId(result, api)
    emit({ runId, type: 'tool_result', callId: 'p', name: 'apply_patch', ok: true, output: 'patched' })
    emit({ runId, type: 'done', stopReason: 'end_turn' })

    // The next turn starts (clearing the checkpoint) before the answer arrives.
    emit({ runId: 'next', type: 'turn_start', conversationId: 'c1', userText: 'more' })
    await act(async () => answer({ runId, files: 4, reverted: false }))
    expect(result.current.checkpoint).toBeNull()
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

  it("keeps a run meter: clock from the turn's start, tokens from the reply so far", async () => {
    const { api, emit } = installApi()
    const { result } = renderHook(() => useChat())
    act(() =>
      result.current.reset([], { context: 100, output: 1000, cost: 0 })
    )
    expect(result.current.meter).toBeNull()
    const before = Date.now()
    const runId = await sendAndGetRunId(result, api)
    expect(result.current.meter?.startedAt).toBeGreaterThanOrEqual(before)
    emit({ runId, type: 'text', delta: 'x'.repeat(80) })
    expect(result.current.meter?.streamedChars).toBe(80)
    // The usage event carries the chat's running total; the meter takes the growth.
    emit({ runId, type: 'usage', inputTokens: 200, outputTokens: 1025, cost: 0 })
    expect(result.current.meter).toMatchObject({ reported: 25, streamedChars: 0 })
    emit({ runId, type: 'usage', inputTokens: 300, outputTokens: 1060, cost: 0 })
    expect(result.current.meter?.reported).toBe(60)
    emit({ runId, type: 'done', stopReason: 'end_turn' })
    expect(result.current.meter).toBeNull()
  })

  it('starts an adopted run\'s clock at the time the run began', () => {
    installApi()
    const { result } = renderHook(() => useChat())
    act(() =>
      result.current.adopt('run-x', [], [{ runId: 'run-x', type: 'text', delta: 'y'.repeat(40) }], 12_345)
    )
    expect(result.current.meter).toEqual({ startedAt: 12_345, reported: 0, streamedChars: 40 })
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

  it('closes a question card as soon as it is answered, even one no tool result will close', async () => {
    const { api, emit } = installApi()
    const { result } = renderHook(() => useChat())
    const runId = await sendAndGetRunId(result, api)
    // A git-guard question, asked under a shell call's own id: no ask_user result follows.
    emit({ runId, type: 'tool_question', callId: 'sh1.git.1', question: 'Keep the change?', options: [{ label: 'Keep' }, { label: 'Undo' }] })
    act(() => result.current.answerQuestion('sh1.git.1', 'Undo'))
    expect(api.answerQuestion).toHaveBeenCalledWith(runId, 'sh1.git.1', 'Undo')
    const card = result.current.items.find((it) => it.kind === 'question')
    expect(card).toMatchObject({ id: 'sh1.git.1', answer: 'Undo' })
  })

  it('keeps what the failed run reported, and seeds it from a saved failure on reset', async () => {
    const { api, emit } = installApi()
    const { result } = renderHook(() => useChat())
    const runId = await sendAndGetRunId(result, api)
    emit({ runId, type: 'error', message: '429 slow down', cause: 'rate-limit' })
    expect(result.current.failure).toEqual({ message: '429 slow down', cause: 'rate-limit' })
    await act(async () => {
      await result.current.retry({ ...SEND })
    })
    expect(result.current.failure).toBeNull()
    act(() => result.current.reset([], null, true, { message: 'saved', cause: 'network' }))
    expect(result.current.failure).toEqual({ message: 'saved', cause: 'network' })
    act(() => result.current.reset([], null, false, { message: 'ignored' }))
    expect(result.current.failure).toBeNull()
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

  it('reset seeds errored from a persisted failure so the Retry banner survives a reload', async () => {
    const { api, emit } = installApi()
    const { result } = renderHook(() => useChat())
    // Drive into a live errored state, then prove reset can both restore and clear it.
    const runId = await sendAndGetRunId(result, api)
    emit({ runId, type: 'done', stopReason: 'end_turn' })
    expect(result.current.errored).toBe(false)

    // Re-open a conversation whose last run had failed: notice + banner restored.
    const errNotice = { kind: 'notice' as const, id: 'n', text: 'kaboom', tone: 'error' as const }
    act(() => result.current.reset([errNotice], null, true))
    expect(result.current.errored).toBe(true)
    expect(result.current.running).toBe(false)
    expect(result.current.items).toEqual([errNotice])

    // Re-opening a healthy conversation clears it (default errored = false).
    act(() => result.current.reset([]))
    expect(result.current.errored).toBe(false)
    expect(result.current.items).toEqual([])
  })

  it('routes cancel, approve, and setPolicy to the active run', async () => {
    const { api } = installApi()
    const { result } = renderHook(() => useChat())
    const runId = await sendAndGetRunId(result, api)

    act(() => result.current.approve('call-1', 'always'))
    expect(api.approveTool).toHaveBeenCalledWith(runId, 'call-1', 'always', undefined)

    act(() => result.current.setPolicy('full-auto'))
    expect(api.setAgentPolicy).toHaveBeenCalledWith(runId, 'full-auto')

    act(() => result.current.cancel())
    expect(api.cancelAgent).toHaveBeenCalledWith(runId)
  })

  it("routes setEffort to the active run, and sends the chat's effort with a turn", async () => {
    const { api } = installApi()
    const { result } = renderHook(() => useChat())
    await act(async () => {
      await result.current.send({
        conversationId: 'c1',
        userText: 'hi',
        providerId: 'p',
        model: 'm',
        approvalPolicy: 'ask',
        reasoningEffort: 'low'
      })
    })
    const req = api.startAgent.mock.calls[0][0]
    expect(req).toMatchObject({ reasoningEffort: 'low' })
    act(() => result.current.setEffort('xhigh'))
    expect(api.setAgentEffort).toHaveBeenCalledWith(req.runId, 'xhigh')
  })

  it('setEffort is a no-op when no run is active', () => {
    const { api } = installApi()
    const { result } = renderHook(() => useChat())
    act(() => result.current.setEffort('low'))
    expect(api.setAgentEffort).not.toHaveBeenCalled()
  })

  it('setPolicy is a no-op when no run is active', () => {
    const { api } = installApi()
    const { result } = renderHook(() => useChat())

    act(() => result.current.setPolicy('plan'))
    expect(api.setAgentPolicy).not.toHaveBeenCalled()
  })

  // The send raced a run this view didn't know about, so main queued it instead of
  // starting a turn: the bubble for a turn that never started goes, and the view
  // follows the live run so its events and Stop reach it.
  it('follows the live run and drops its own bubble when main queued the send', async () => {
    const { api, emit } = installApi()
    api.startAgent.mockResolvedValueOnce({ queuedBehind: 'live-run' })
    const { result } = renderHook(() => useChat())
    await act(async () => {
      await result.current.send({ ...SEND })
    })
    expect(result.current.items.some((it) => it.kind === 'user' && it.text === 'hello')).toBe(false)
    expect(result.current.running).toBe(true)
    emit({ runId: 'live-run', type: 'text', delta: 'from the live run' })
    expect(result.current.items.some((it) => it.kind === 'assistant' && it.text.includes('from the live run'))).toBe(
      true
    )
    act(() => result.current.cancel())
    expect(api.cancelAgent).toHaveBeenCalledWith('live-run')
  })

  it('keeps an already-adopted run when main queued the send behind it', async () => {
    const { api, emit } = installApi()
    let reply: (r: AgentStartResult) => void = () => {}
    api.startAgent.mockReturnValueOnce(new Promise((r) => (reply = r)))
    const { result } = renderHook(() => useChat('c1'))
    let sent: Promise<void> = Promise.resolve()
    act(() => {
      sent = result.current.send({ ...SEND })
    })
    // The queued follow-up's turn_start lands before main's reply to the send.
    emit({ runId: 'drained', type: 'turn_start', conversationId: 'c1', userText: 'earlier' })
    await act(async () => {
      reply({ queuedBehind: 'drained' })
      await sent
    })
    expect(result.current.items.filter((it) => it.kind === 'user').map((it) => (it as { text: string }).text)).toEqual([
      'earlier'
    ])
    act(() => result.current.cancel())
    expect(api.cancelAgent).toHaveBeenCalledWith('drained')
  })

  it('reverts and re-applies a checkpoint through the bridge', async () => {
    const { api, emit } = installApi()
    const { result } = renderHook(() => useChat())
    const runId = await sendAndGetRunId(result, api)
    emit({ runId, type: 'tool_result', callId: 'a', name: 'write_file', ok: true, output: 'wrote' })

    let restored: number | null = 0
    await act(async () => {
      restored = await result.current.revertCheckpoint()
    })
    expect(restored).toBe(3)
    expect(api.restoreCheckpoint).toHaveBeenCalledWith(runId)
    expect(result.current.checkpoint).toMatchObject({ runId, reverted: true })

    let reapplied: number | null = 0
    await act(async () => {
      reapplied = await result.current.reapplyCheckpoint()
    })
    expect(reapplied).toBe(2)
    expect(api.reapplyCheckpoint).toHaveBeenCalledWith(runId)
    expect(result.current.checkpoint).toMatchObject({ runId, reverted: false })
  })

  it('adopts a turn_start for the open conversation: adds the user bubble and runs', async () => {
    const { emit } = installApi()
    const { result } = renderHook(() => useChat('c1'))
    expect(result.current.running).toBe(false)

    // The main process auto-started a follow-up turn from the queue for c1.
    emit({ runId: 'r-flush', type: 'turn_start', conversationId: 'c1', userText: 'do A\n\ndo B' })

    expect(result.current.running).toBe(true)
    expect(result.current.errored).toBe(false)
    expect(result.current.items).toHaveLength(1)
    expect(result.current.items[0]).toMatchObject({ kind: 'user', text: 'do A\n\ndo B' })

    // Subsequent events for the adopted run are now processed.
    emit({ runId: 'r-flush', type: 'text', delta: 'hi' })
    expect(result.current.items.some((i) => i.kind === 'assistant')).toBe(true)
    emit({ runId: 'r-flush', type: 'done', stopReason: 'end_turn' })
    expect(result.current.running).toBe(false)
  })

  it('ignores a turn_start for a different conversation', async () => {
    const { emit } = installApi()
    const { result } = renderHook(() => useChat('c1'))

    emit({ runId: 'r-bg', type: 'turn_start', conversationId: 'other', userText: 'background work' })

    expect(result.current.running).toBe(false)
    expect(result.current.items).toHaveLength(0)
  })

  it('adopt re-attaches to an in-flight run and restores the running state', async () => {
    const { api, emit } = installApi()
    const { result } = renderHook(() => useChat())

    // Simulate re-opening a conversation whose run is still active in main: reset
    // rebuilds the transcript (running=false), then adopt re-attaches to the run.
    act(() => result.current.reset([{ kind: 'user', id: 'u1', text: 'still going' }]))
    expect(result.current.running).toBe(false)

    act(() => result.current.adopt('live-run'))
    expect(result.current.running).toBe(true)
    expect(result.current.errored).toBe(false)

    // Events from the adopted run now flow again, and controls route back to it.
    emit({ runId: 'live-run', type: 'tool_result', callId: 'a', name: 'write_file', ok: true, output: 'wrote' })
    expect(result.current.checkpoint).toEqual({ runId: 'live-run', files: 1, reverted: false })

    act(() => result.current.cancel())
    expect(api.cancelAgent).toHaveBeenCalledWith('live-run')

    // The adopted run finishing clears the running state.
    emit({ runId: 'live-run', type: 'done', stopReason: 'end_turn' })
    expect(result.current.running).toBe(false)
  })

  it('drops events from other runs after adopting a specific run', async () => {
    const { emit } = installApi()
    const { result } = renderHook(() => useChat())

    act(() => result.current.adopt('live-run'))
    // An event from a different (e.g. previously viewed) run must be ignored.
    emit({ runId: 'other-run', type: 'tool_result', callId: 'x', name: 'write_file', ok: true, output: 'ok' })
    expect(result.current.checkpoint).toBeNull()
    expect(result.current.running).toBe(true)
  })

  it('replays pending prompts on adopt so a parked approval re-renders and is answerable', async () => {
    const { api } = installApi()
    const { result } = renderHook(() => useChat())

    // Re-opening a conversation whose run is parked on an approval: the call is
    // first rebuilt from the persisted log as a plain tool row...
    act(() => result.current.reset([{ kind: 'tool', id: 'w1', name: 'write_file', status: 'done' }]))

    // ...then adopt replays the still-pending approval prompt.
    act(() =>
      result.current.adopt('live-run', [
        {
          runId: 'live-run',
          type: 'tool_approval',
          callId: 'w1',
          name: 'write_file',
          summary: 'write out.txt',
          kind: 'write'
        }
      ])
    )

    expect(result.current.running).toBe(true)
    const tools = result.current.items.filter((i) => i.kind === 'tool' && i.id === 'w1')
    expect(tools).toHaveLength(1)
    expect((tools[0] as { status: string }).status).toBe('awaiting-approval')

    // Answering the replayed prompt routes to the adopted run.
    act(() => result.current.approve('w1', 'allow'))
    expect(api.approveTool).toHaveBeenCalledWith('live-run', 'w1', 'allow', undefined)
  })

  it('replays the live transcript on adopt so mid-turn streamed output is restored', async () => {
    const { emit } = installApi()
    const { result } = renderHook(() => useChat('c1'))

    // Re-opening a freshly spawned session mid-first-turn: the disk log holds only
    // the seeded user message (the streamed assistant text isn't persisted yet).
    act(() => result.current.reset([{ kind: 'user', id: 'u1', text: 'do the thing' }]))
    expect(result.current.items.some((i) => i.kind === 'assistant')).toBe(false)

    // adopt replays the in-flight transcript that main had buffered since the last
    // persist — streamed deltas (reconstructing the bubble) plus a running tool.
    act(() =>
      result.current.adopt(
        'live-run',
        [],
        [
          { runId: 'live-run', type: 'text', delta: 'Working on ' },
          { runId: 'live-run', type: 'text', delta: 'it now.' },
          { runId: 'live-run', type: 'tool_start', callId: 't1', name: 'read_file', args: {} }
        ]
      )
    )

    expect(result.current.running).toBe(true)
    // The streamed assistant text is rebuilt from the replayed deltas (finalized, as a
    // real tool_start would), so no output is lost on switch-back...
    const assistants = result.current.items.filter((i) => i.kind === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0]).toMatchObject({ text: 'Working on it now.' })
    // ...and the running tool row is present.
    expect(result.current.items.some((i) => i.kind === 'tool' && i.id === 't1')).toBe(true)

    // Live events resume seamlessly after the replay: the tool completes and a fresh
    // assistant bubble streams in, all keyed to the adopted run.
    emit({ runId: 'live-run', type: 'tool_result', callId: 't1', name: 'read_file', ok: true, output: 'data' })
    emit({ runId: 'live-run', type: 'text', delta: 'All done.' })
    const tool = result.current.items.find((i) => i.kind === 'tool' && i.id === 't1')
    expect((tool as { status: string }).status).toBe('done')
    const after = result.current.items.filter((i) => i.kind === 'assistant')
    expect(after).toHaveLength(2)
    expect(after[1]).toMatchObject({ text: 'All done.' })
  })

  it('does not duplicate a prompt already in the live transcript replayed on adopt', async () => {
    const { emit } = installApi()
    const { result } = renderHook(() => useChat('c1'))
    act(() => result.current.reset([{ kind: 'user', id: 'u1', text: 'go' }]))

    // The buffered transcript already carries the pending approval, and pendingPrompts
    // repeats it — reduceEvent upserts by callId, so the row must appear exactly once.
    const approval: AgentEvent = {
      runId: 'live-run',
      type: 'tool_approval',
      callId: 'w1',
      name: 'write_file',
      summary: 'write out.txt',
      kind: 'write'
    }
    act(() =>
      result.current.adopt(
        'live-run',
        [approval],
        [{ runId: 'live-run', type: 'text', delta: 'let me write a file' }, approval]
      )
    )

    const tools = result.current.items.filter((i) => i.kind === 'tool' && i.id === 'w1')
    expect(tools).toHaveLength(1)
    expect((tools[0] as { status: string }).status).toBe('awaiting-approval')
    emit({ runId: 'live-run', type: 'done', stopReason: 'end_turn' })
  })

  it('seedCheckpoint restores the revert/redo affordance on re-open', async () => {
    const { api } = installApi()
    const { result } = renderHook(() => useChat())

    // Re-opening a conversation: reset clears the (event-built) checkpoint...
    act(() => result.current.reset([{ kind: 'user', id: 'u1', text: 'did work' }]))
    expect(result.current.checkpoint).toBeNull()

    // ...then the fetched latest-run checkpoint is seeded back.
    act(() => result.current.seedCheckpoint({ runId: 'r9', files: 2, reverted: true }))
    expect(result.current.checkpoint).toEqual({ runId: 'r9', files: 2, reverted: true })

    // It routes restore/reapply to that run.
    await act(async () => {
      await result.current.reapplyCheckpoint()
    })
    expect(api.reapplyCheckpoint).toHaveBeenCalledWith('r9')
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

  it('adopt handles the events that arrived while the reopen was still reading, last', () => {
    installApi()
    const { result } = renderHook(() => useChat('c1'))
    act(() => result.current.reset([{ kind: 'user', id: 'u1', text: 'go' }]))
    act(() =>
      result.current.adopt(
        'live-run',
        [],
        [{ runId: 'live-run', type: 'text', delta: 'hello ' }],
        undefined,
        [
          { runId: 'live-run', type: 'text', delta: 'world' },
          { runId: 'live-run', type: 'done', stopReason: 'end_turn' }
        ]
      )
    )
    const replies = result.current.items.filter((i) => i.kind === 'assistant')
    expect(replies).toHaveLength(1)
    expect((replies[0] as { text: string }).text).toBe('hello world')
    // The run finished in that gap, so the view isn't left running with no run.
    expect(result.current.running).toBe(false)
  })

  it('startDetached starts a turn in another chat without touching this view', async () => {
    const { api } = installApi()
    const { result } = renderHook(() => useChat('c1'))
    act(() => result.current.reset([{ kind: 'user', id: 'u1', text: 'mine' }]))
    let ok = false
    await act(async () => {
      ok = await result.current.startDetached({ ...SEND, conversationId: 'c2', userText: 'theirs' })
    })
    expect(ok).toBe(true)
    expect(api.startAgent.mock.calls[0][0]).toMatchObject({ conversationId: 'c2', userText: 'theirs' })
    expect(result.current.items).toEqual([{ kind: 'user', id: 'u1', text: 'mine' }])
    expect(result.current.running).toBe(false)

    api.startAgent.mockRejectedValueOnce(new Error('bridge down'))
    await act(async () => {
      ok = await result.current.startDetached({ ...SEND, conversationId: 'c2' })
    })
    expect(ok).toBe(false)
  })

  it('a revert that finishes after switching chats leaves the new chat’s checkpoint alone', async () => {
    const { api } = installApi()
    let finish!: (n: number) => void
    api.restoreCheckpoint.mockImplementationOnce(() => new Promise<number>((r) => (finish = r)))
    const { result, rerender } = renderHook(({ id }) => useChat(id), { initialProps: { id: 'c1' } })
    act(() => result.current.seedCheckpoint({ runId: 'r1', files: 1, reverted: false }))
    let pending!: Promise<number | null>
    act(() => {
      pending = result.current.revertCheckpoint()
    })
    // The user opens c2, which has its own checkpoint.
    rerender({ id: 'c2' })
    act(() => result.current.seedCheckpoint({ runId: 'r2', files: 4, reverted: false }))
    await act(async () => {
      finish(1)
      await pending
    })
    expect(result.current.checkpoint).toEqual({ runId: 'r2', files: 4, reverted: false })
  })

  it('a failed revert or redo says so in the chat instead of rejecting', async () => {
    const { api } = installApi()
    api.restoreCheckpoint.mockRejectedValueOnce(new Error('disk gone'))
    api.reapplyCheckpoint.mockRejectedValueOnce(new Error('disk gone'))
    const { result } = renderHook(() => useChat('c1'))
    act(() => result.current.seedCheckpoint({ runId: 'r1', files: 1, reverted: false }))
    let n: number | null = 0
    await act(async () => {
      n = await result.current.revertCheckpoint()
    })
    expect(n).toBeNull()
    expect(result.current.checkpoint).toEqual({ runId: 'r1', files: 1, reverted: false })
    await act(async () => {
      n = await result.current.reapplyCheckpoint()
    })
    expect(n).toBeNull()
    const notices = result.current.items.filter((i) => i.kind === 'notice').map((i) => (i as { text: string }).text)
    expect(notices).toEqual([
      "Couldn't revert this turn's changes: disk gone",
      "Couldn't redo this turn's changes: disk gone"
    ])
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

/** Display frames the test runs by hand; null leaves `requestAnimationFrame` unset. */
function manualFrames(): { run: () => void; pending: () => number } {
  let queue: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => queue.push(cb))
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    queue = queue.filter((_, i) => i + 1 !== id)
  })
  return {
    run: () =>
      act(() => {
        const due = queue
        queue = []
        for (const cb of due) cb(performance.now())
      }),
    pending: () => queue.length
  }
}

const assistantText = (items: ReturnType<typeof useChat>['items']): string =>
  items
    .filter((i) => i.kind === 'assistant')
    .map((i) => (i as { text: string }).text)
    .join('|')

describe('useChat: one controller, events applied per frame', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('keeps the controller while nothing changes, and every method through a run', async () => {
    const { api, emit } = installApi()
    manualFrames()
    const { result, rerender } = renderHook(() => useChat('c1'))
    const first = result.current
    rerender()
    expect(result.current).toBe(first)

    const runId = await sendAndGetRunId(result, api)
    emit({ runId, type: 'text', delta: 'hi' })
    emit({ runId, type: 'tool_result', callId: 'a', name: 'write_file', ok: true, output: 'wrote' })
    const during = result.current
    expect(during).not.toBe(first)
    for (const key of Object.keys(first) as (keyof typeof first)[]) {
      if (typeof first[key] === 'function') expect({ key, same: during[key] === first[key] }).toEqual({ key, same: true })
    }
  })

  it('applies a burst of streamed deltas once per frame, the first at once', async () => {
    const { api, emit } = installApi()
    const frames = manualFrames()
    let renders = 0
    const { result } = renderHook(() => {
      renders++
      return useChat('c1')
    })
    const runId = await sendAndGetRunId(result, api)

    const before = renders
    emit({ runId, type: 'text', delta: 'a' })
    // Quiet until now, so it shows without waiting for a frame...
    expect(assistantText(result.current.items)).toBe('a')
    expect(renders).toBe(before + 1)
    // ...and what follows inside the frame is held for it.
    emit({ runId, type: 'text', delta: 'b' })
    emit({ runId, type: 'reasoning', delta: 'r' })
    emit({ runId, type: 'text', delta: 'c' })
    expect(assistantText(result.current.items)).toBe('a')
    expect(renders).toBe(before + 1)
    frames.run()
    expect(assistantText(result.current.items)).toBe('abc')
    expect(renders).toBe(before + 2)

    // Still streaming: the next frame gathers again rather than going back to one per event.
    emit({ runId, type: 'text', delta: 'd' })
    emit({ runId, type: 'text', delta: 'e' })
    expect(assistantText(result.current.items)).toBe('abc')
    frames.run()
    expect(assistantText(result.current.items)).toBe('abcde')
    expect(renders).toBe(before + 3)
    // Every held delta reached the meter too (text and reasoning).
    expect(result.current.meter?.streamedChars).toBe(6)

    // A frame with nothing new ends the gathering: the next delta shows at once again.
    frames.run()
    expect(frames.pending()).toBe(0)
    emit({ runId, type: 'text', delta: 'f' })
    expect(assistantText(result.current.items)).toBe('abcdef')
  })

  it('applies what needs the user at once, after what was held, in order', async () => {
    const { api, emit } = installApi()
    manualFrames()
    const { result } = renderHook(() => useChat('c1'))
    const runId = await sendAndGetRunId(result, api)
    emit({ runId, type: 'text', delta: 'Let me ' })
    emit({ runId, type: 'text', delta: 'write it.' })
    // No frame yet: the approval card shows now, below the text that came before it.
    emit({ runId, type: 'tool_approval', callId: 'w1', name: 'write_file', summary: 'write a.txt', kind: 'write' })
    expect(assistantText(result.current.items)).toBe('Let me write it.')
    const kinds = result.current.items.map((i) => i.kind)
    expect(kinds.slice(-2)).toEqual(['assistant', 'tool'])
    expect((result.current.items.at(-1) as { status: string }).status).toBe('awaiting-approval')

    for (const blocking of [
      { runId, type: 'tool_question', callId: 'q1', question: 'Which one?', options: [] },
      { runId, type: 'plan_ready', callId: 'p1', plan: { title: 'Plan', body: '1. do it' } }
    ] as AgentEvent[]) {
      emit({ runId, type: 'text', delta: ' more' })
      emit({ runId, type: 'text', delta: ' text' })
      emit(blocking)
      expect(result.current.items.at(-1)?.id).toBe((blocking as { callId: string }).callId)
    }
    expect(result.current.pendingPlan?.callId).toBe('p1')

    emit({ runId, type: 'text', delta: ' last' })
    emit({ runId, type: 'text', delta: ' words' })
    emit({ runId, type: 'done', stopReason: 'end_turn' })
    expect(result.current.running).toBe(false)
    expect(assistantText(result.current.items)).toContain(' last words')
  })

  it('applies held deltas on an error before the run ends', async () => {
    const { api, emit } = installApi()
    manualFrames()
    const { result } = renderHook(() => useChat('c1'))
    const runId = await sendAndGetRunId(result, api)
    emit({ runId, type: 'text', delta: 'one' })
    emit({ runId, type: 'text', delta: ' two' })
    emit({ runId, type: 'error', message: 'boom' })
    expect(assistantText(result.current.items)).toBe('one two')
    expect(result.current.errored).toBe(true)
  })

  it('still applies held deltas when no frame comes (a hidden window)', async () => {
    vi.useFakeTimers()
    const { api, emit } = installApi()
    manualFrames()
    const { result } = renderHook(() => useChat('c1'))
    const runId = await sendAndGetRunId(result, api)
    emit({ runId, type: 'text', delta: 'seen' })
    emit({ runId, type: 'text', delta: ' later' })
    expect(assistantText(result.current.items)).toBe('seen')
    act(() => void vi.advanceTimersByTime(250))
    expect(assistantText(result.current.items)).toBe('seen later')
  })

  it('drops held deltas when the transcript is replaced, so a re-adopted run shows them once', async () => {
    const { api, emit } = installApi()
    const frames = manualFrames()
    const { result } = renderHook(() => useChat('c1'))
    const runId = await sendAndGetRunId(result, api)
    emit({ runId, type: 'text', delta: 'Hello' })
    emit({ runId, type: 'text', delta: ' world' })
    // Switching away and back: the live transcript main returns already holds both deltas.
    act(() => result.current.reset([{ kind: 'user', id: 'u1', text: 'hi' }]))
    act(() =>
      result.current.adopt(runId, [], [
        { runId, type: 'text', delta: 'Hello' },
        { runId, type: 'text', delta: ' world' }
      ])
    )
    frames.run()
    expect(assistantText(result.current.items)).toBe('Hello world')
  })

  it("holds nothing for another chat's run", async () => {
    const { api, emit } = installApi()
    const frames = manualFrames()
    const { result } = renderHook(() => useChat('c1'))
    const runId = await sendAndGetRunId(result, api)
    emit({ runId: 'background', type: 'text', delta: 'not mine' })
    expect(frames.pending()).toBe(0)
    emit({ runId, type: 'text', delta: 'mine' })
    expect(assistantText(result.current.items)).toBe('mine')
  })
})
