import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, StopReason } from '@shared/agent'
import type { QueuedInputMeta } from '@shared/queue'
import { addToQueue, clearQueue, listQueue } from './queue'
import { runAndDrain, type DrainIO } from './drain'

// Mock the run loop and the conversation store; use the real queue manager so the
// drain path is exercised end-to-end against actual queue state.
const h = vi.hoisted(() => ({
  startRun: vi.fn(),
  getConversation: vi.fn(),
  setMessages: vi.fn(),
  setConversationError: vi.fn(),
  updateConversationMeta: vi.fn(),
  maybeGenerateTitle: vi.fn(() => Promise.resolve())
}))
vi.mock('./loop', () => ({ startRun: h.startRun }))
// Auto-titling has its own tests (title.test.ts); here we only assert drain wires it
// up on a natural completion, so stub it out rather than reaching the provider/store.
vi.mock('./title', () => ({ maybeGenerateTitle: h.maybeGenerateTitle }))
vi.mock('../conversations', () => ({
  getConversation: h.getConversation,
  setMessages: h.setMessages,
  setConversationError: h.setConversationError,
  updateConversationMeta: h.updateConversationMeta
}))

/** Make startRun end every run with the given stop reason (or an error event). */
function endRunsWith(terminal: { done: StopReason } | { error: string }): void {
  h.startRun.mockImplementation(async (req: { runId: string }, send: (e: AgentEvent) => void) => {
    if ('error' in terminal) send({ runId: req.runId, type: 'error', message: terminal.error })
    else send({ runId: req.runId, type: 'done', stopReason: terminal.done })
  })
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function io() {
  const emit = vi.fn<(conversationId: string, e: AgentEvent) => void>()
  const emitQueueChanged = vi.fn<(conversationId: string, items: QueuedInputMeta[]) => void>()
  return { emit, emitQueueChanged } satisfies DrainIO
}

function runReq(conversationId: string) {
  return {
    runId: `run-${conversationId}`,
    workspace: '/ws',
    providerId: 'anthropic',
    model: 'claude',
    approvalPolicy: 'ask' as const,
    messages: []
  }
}

describe('runAndDrain', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.getConversation.mockImplementation((id: string) => ({
      id,
      title: 'T',
      workspace: '/ws',
      providerId: 'anthropic',
      model: 'claude',
      createdAt: 0,
      updatedAt: 0,
      messages: []
    }))
  })

  it('flushes the queue as one combined turn after a natural completion', async () => {
    const cid = 'conv-natural'
    addToQueue({ conversationId: cid, userText: 'A', providerId: 'anthropic', model: 'm1', approvalPolicy: 'ask' })
    addToQueue({ conversationId: cid, userText: 'B', providerId: 'anthropic', model: 'm2', approvalPolicy: 'full-auto' })
    endRunsWith({ done: 'end_turn' })
    const sink = io()

    await runAndDrain(sink, cid, runReq(cid))
    await settle()

    // The original run plus exactly one flush run.
    expect(h.startRun).toHaveBeenCalledTimes(2)

    // A turn_start was emitted so a viewing renderer can render the bubble + adopt.
    const turnStart = sink.emit.mock.calls.map(([, e]) => e).find((e) => e.type === 'turn_start')
    expect(turnStart).toMatchObject({ conversationId: cid, userText: 'A\n\nB' })
    if (turnStart?.type !== 'turn_start') throw new Error('expected a turn_start event')

    // The flush run carries the combined user message and the newest send settings.
    const flushReq = h.startRun.mock.calls[1][0]
    expect(flushReq.runId).toBe(turnStart.runId)
    expect(flushReq.messages).toEqual([{ role: 'user', content: 'A\n\nB' }])
    expect(flushReq.model).toBe('m2')
    expect(flushReq.approvalPolicy).toBe('full-auto')

    expect(h.setMessages).toHaveBeenCalledWith(cid, [{ role: 'user', content: 'A\n\nB' }])
    expect(sink.emitQueueChanged).toHaveBeenCalledWith(cid, [])
    expect(listQueue(cid)).toEqual([]) // drained
  })

  it('holds the queue on error (no flush, no turn_start)', async () => {
    const cid = 'conv-error'
    addToQueue({ conversationId: cid, userText: 'A', providerId: 'anthropic', model: 'm', approvalPolicy: 'ask' })
    endRunsWith({ error: 'kaboom' })
    const sink = io()

    await runAndDrain(sink, cid, runReq(cid))
    await settle()

    expect(h.startRun).toHaveBeenCalledTimes(1)
    expect(sink.emit.mock.calls.some(([, e]) => e.type === 'turn_start')).toBe(false)
    expect(h.maybeGenerateTitle).not.toHaveBeenCalled() // no auto-title on error
    expect(listQueue(cid).map((q) => q.text)).toEqual(['A']) // still held
    // The failure is persisted so the Retry banner survives a reload — cleared at
    // run start, then re-set with the error message once the run ends.
    expect(h.setConversationError).toHaveBeenNthCalledWith(1, cid, null)
    expect(h.setConversationError).toHaveBeenLastCalledWith(cid, { message: 'kaboom' })
    clearQueue(cid)
  })

  it('holds the queue on cancel/abort (no flush)', async () => {
    const cid = 'conv-aborted'
    addToQueue({ conversationId: cid, userText: 'A', providerId: 'anthropic', model: 'm', approvalPolicy: 'ask' })
    endRunsWith({ done: 'aborted' })
    const sink = io()

    await runAndDrain(sink, cid, runReq(cid))
    await settle()

    expect(h.startRun).toHaveBeenCalledTimes(1)
    expect(sink.emit.mock.calls.some(([, e]) => e.type === 'turn_start')).toBe(false)
    expect(h.maybeGenerateTitle).not.toHaveBeenCalled() // no auto-title on abort
    expect(listQueue(cid).map((q) => q.text)).toEqual(['A'])
    // An abort isn't a failure to retry: the marker is cleared at start and never
    // re-set, so no Retry banner is persisted.
    expect(h.setConversationError).toHaveBeenCalledWith(cid, null)
    expect(h.setConversationError).not.toHaveBeenCalledWith(cid, expect.objectContaining({ message: expect.anything() }))
    clearQueue(cid)
  })

  it('does nothing extra when the queue is empty on a natural completion', async () => {
    const cid = 'conv-empty'
    endRunsWith({ done: 'end_turn' })
    const sink = io()

    await runAndDrain(sink, cid, runReq(cid))
    await settle()

    expect(h.startRun).toHaveBeenCalledTimes(1)
    expect(sink.emit.mock.calls.some(([, e]) => e.type === 'turn_start')).toBe(false)
    expect(sink.emitQueueChanged).not.toHaveBeenCalled()
    // The natural completion still triggers a one-shot auto-title for this run.
    expect(h.maybeGenerateTitle).toHaveBeenCalledTimes(1)
    expect(h.maybeGenerateTitle).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: cid, providerId: 'anthropic', model: 'claude' })
    )
  })

  it('marks runs interactive by default, including the queued flush', async () => {
    // A window is watching a runAndDrain run, so it must be interactive — otherwise
    // the weak no-progress stall hard-stops a read-only GUI investigation instead of
    // nudging (the "repeating myself" false stop). The queued follow-up turn goes
    // back through runAndDrain, so it inherits the same default.
    const cid = 'conv-interactive'
    addToQueue({ conversationId: cid, userText: 'A', providerId: 'anthropic', model: 'm', approvalPolicy: 'ask' })
    endRunsWith({ done: 'end_turn' })

    await runAndDrain(io(), cid, runReq(cid))
    await settle()

    expect(h.startRun).toHaveBeenCalledTimes(2)
    expect(h.startRun.mock.calls[0][0].interactive).toBe(true) // original turn
    expect(h.startRun.mock.calls[1][0].interactive).toBe(true) // queued flush
    clearQueue(cid)
  })

  it('preserves an explicit interactive:false (autonomous background run)', async () => {
    const cid = 'conv-bg'
    endRunsWith({ done: 'end_turn' })

    await runAndDrain(io(), cid, { ...runReq(cid), interactive: false })
    await settle()

    expect(h.startRun.mock.calls[0][0].interactive).toBe(false)
  })
})
