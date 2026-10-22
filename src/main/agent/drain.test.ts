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
// up at turn start (plus a natural-completion fallback), so stub it out rather than reaching the provider/store.
vi.mock('./title', () => ({ maybeGenerateTitle: h.maybeGenerateTitle }))
vi.mock('../conversations', () => ({
  getConversation: h.getConversation,
  setMessages: h.setMessages,
  setConversationError: h.setConversationError,
  updateConversationMeta: h.updateConversationMeta,
  // The queue's disk copy (covered in queue.test.ts); nothing stored here.
  getQueuedInput: () => null,
  setQueuedInput: () => {}
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

  it('offers gallery tools to every run of a client that draws galleries, queued follow-ups included', async () => {
    const cid = 'conv-gallery'
    addToQueue({ conversationId: cid, userText: 'A', providerId: 'anthropic', model: 'm1', approvalPolicy: 'ask' })
    endRunsWith({ done: 'end_turn' })
    await runAndDrain({ ...io(), imageGallery: true }, cid, runReq(cid))
    await settle()
    expect(h.startRun).toHaveBeenCalledTimes(2)
    expect(h.startRun.mock.calls.map((c) => c[0].imageGallery)).toEqual([true, true])
  })

  it('leaves the gallery flag off for a client that draws none', async () => {
    endRunsWith({ done: 'end_turn' })
    await runAndDrain(io(), 'conv-plain', runReq('conv-plain'))
    expect(h.startRun.mock.calls[0][0].imageGallery).toBeUndefined()
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

  it("runs and records a flushed turn under the chat's own effort and policy", async () => {
    const cid = 'conv-chat-settings'
    addToQueue({
      conversationId: cid,
      userText: 'A',
      providerId: 'anthropic',
      model: 'm1',
      approvalPolicy: 'plan',
      reasoningEffort: 'low'
    })
    endRunsWith({ done: 'end_turn' })
    await runAndDrain(io(), cid, runReq(cid))
    await settle()
    expect(h.startRun.mock.calls[1][0]).toMatchObject({ approvalPolicy: 'plan', reasoningEffort: 'low' })
    expect(h.updateConversationMeta).toHaveBeenCalledWith(cid, {
      providerId: 'anthropic',
      model: 'm1',
      approvalPolicy: 'plan',
      reasoningEffort: 'low'
    })
  })

  it('keeps a lone queued first-party prompt tagged through the flush', async () => {
    const cid = 'conv-invoked'
    const invokedAs = { kind: 'action', label: 'Create PR' } as const
    addToQueue({
      conversationId: cid,
      userText: 'Create a GitHub pull request…',
      invokedAs,
      providerId: 'anthropic',
      model: 'm1',
      approvalPolicy: 'ask'
    })
    endRunsWith({ done: 'end_turn' })
    const sink = io()

    await runAndDrain(sink, cid, runReq(cid))
    await settle()

    const turnStart = sink.emit.mock.calls.map(([, e]) => e).find((e) => e.type === 'turn_start')
    expect(turnStart).toMatchObject({ userText: 'Create a GitHub pull request…', invokedAs })
    expect(h.setMessages).toHaveBeenCalledWith(cid, [
      { role: 'user', content: 'Create a GitHub pull request…', invokedAs }
    ])
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
    // Titling starts with the turn, so an errored turn is still titled — but the
    // natural-completion fallback doesn't fire.
    expect(h.maybeGenerateTitle).toHaveBeenCalledTimes(1)
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
    expect(h.maybeGenerateTitle).toHaveBeenCalledTimes(1) // turn-start only, no fallback
    expect(listQueue(cid).map((q) => q.text)).toEqual(['A'])
    // An abort isn't a failure to retry: the marker is cleared at start and never
    // re-set, so no Retry banner is persisted.
    expect(h.setConversationError).toHaveBeenCalledWith(cid, null)
    expect(h.setConversationError).not.toHaveBeenCalledWith(cid, expect.objectContaining({ message: expect.anything() }))
    clearQueue(cid)
  })

  it('starts titling before the turn runs, not after it ends', async () => {
    const cid = 'conv-title-early'
    let calledBeforeRun = -1
    h.startRun.mockImplementation(async (req: { runId: string }, send: (e: AgentEvent) => void) => {
      calledBeforeRun = h.maybeGenerateTitle.mock.calls.length
      send({ runId: req.runId, type: 'done', stopReason: 'end_turn' })
    })

    await runAndDrain(io(), cid, runReq(cid))

    expect(calledBeforeRun).toBe(1)
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
    // Titling fires at turn start and again as the natural-completion fallback
    // (maybeGenerateTitle itself makes the second a no-op once titled/in flight).
    expect(h.maybeGenerateTitle).toHaveBeenCalledTimes(2)
    expect(h.maybeGenerateTitle).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: cid, providerId: 'anthropic', model: 'claude' })
    )
  })

  // A steer's queue entry is its durable copy until the run reads it (QueuedInput.steer).
  describe('steers', () => {
    const steerIn = (cid: string, text: string, id: string): void => {
      addToQueue(
        { conversationId: cid, userText: text, providerId: 'anthropic', model: 'm', approvalPolicy: 'ask' },
        { id, steer: true }
      )
    }

    it('drops the queue entry once the run has read the steer, after its persist', async () => {
      const cid = 'conv-steer-landed'
      steerIn(cid, 'use YAML', 's1')
      let listedAtEmit: string[] = []
      h.startRun.mockImplementation(async (req: { runId: string }, send: (e: AgentEvent) => void) => {
        send({ runId: req.runId, type: 'steered', text: 'use YAML', id: 's1' })
        // Still there while the run persists the steer into the log (same tick).
        listedAtEmit = listQueue(cid).map((q) => q.id)
        await Promise.resolve()
        send({ runId: req.runId, type: 'done', stopReason: 'end_turn' })
      })
      const sink = io()
      await runAndDrain(sink, cid, runReq(cid))
      await settle()
      expect(listedAtEmit).toEqual(['s1'])
      expect(listQueue(cid)).toEqual([])
      expect(sink.emitQueueChanged).toHaveBeenCalledWith(cid, [])
      // Landed, so it is not also sent again as a follow-up.
      expect(h.startRun).toHaveBeenCalledTimes(1)
    })

    it('holds a steer the run never read as a plain follow-up when the run fails', async () => {
      const cid = 'conv-steer-error'
      steerIn(cid, 'also add tests', 's2')
      endRunsWith({ error: 'network down' })
      const sink = io()
      await runAndDrain(sink, cid, runReq(cid))
      await settle()
      const held = [{ id: 's2', text: 'also add tests', imageCount: 0 }] // no `steer`: nothing is running
      expect(listQueue(cid)).toEqual(held)
      expect(sink.emitQueueChanged).toHaveBeenCalledWith(cid, held)
      expect(h.startRun).toHaveBeenCalledTimes(1) // held for the user, not auto-sent
      clearQueue(cid)
    })

    it('holds a steer the run never read when the run is stopped', async () => {
      const cid = 'conv-steer-stop'
      steerIn(cid, 'wait', 's3')
      endRunsWith({ done: 'aborted' })
      await runAndDrain(io(), cid, runReq(cid))
      await settle()
      expect(listQueue(cid)).toEqual([{ id: 's3', text: 'wait', imageCount: 0 }])
      clearQueue(cid)
    })

    it('sends a steer the run never read as the next turn when the run finishes', async () => {
      const cid = 'conv-steer-natural'
      steerIn(cid, 'and the docs', 's4')
      endRunsWith({ done: 'end_turn' })
      await runAndDrain(io(), cid, runReq(cid))
      await settle()
      expect(h.startRun).toHaveBeenCalledTimes(2)
      expect(h.startRun.mock.calls[1][0].messages).toEqual([{ role: 'user', content: 'and the docs' }])
    })
  })
})
