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
  updateConversationMeta: vi.fn()
}))
vi.mock('./loop', () => ({ startRun: h.startRun }))
vi.mock('../conversations', () => ({
  getConversation: h.getConversation,
  setMessages: h.setMessages,
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
    expect(listQueue(cid).map((q) => q.text)).toEqual(['A']) // still held
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
    expect(listQueue(cid).map((q) => q.text)).toEqual(['A'])
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
  })
})
