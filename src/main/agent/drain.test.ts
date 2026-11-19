import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, StopReason } from '@shared/agent'
import type { QueuedInputMeta } from '@shared/queue'
import { addToQueue, clearQueue, listQueue } from './queue'
import { drainQueue, runAndDrain, startWakeTurn, type DrainIO } from './drain'
import {
  WAKE_DEBOUNCE_MS,
  hasBackgroundNews,
  pushBackgroundEvent,
  resetBackgroundEventsForTest,
  setWakeHost
} from './backgroundEvents'
import { withRewindLock } from './rewindLock'
import { holdCompaction, releaseCompaction } from './compactionLock'

// Mock the run loop and the conversation store; use the real queue manager so the
// drain path is exercised end-to-end against actual queue state.
const h = vi.hoisted(() => ({
  startRun: vi.fn(),
  getConversation: vi.fn(),
  setMessages: vi.fn(),
  setConversationError: vi.fn(),
  updateConversationMeta: vi.fn(),
  maybeGenerateTitle: vi.fn(() => Promise.resolve()),
  maybeSuggestNext: vi.fn((_opts: { conversationId: string; onSuggestion: (t: string) => void }) => Promise.resolve()),
  activeRun: vi.fn((): string | null => null),
  runningElsewhere: vi.fn((): number | null => null),
  takeChildReports: vi.fn((): unknown[] => [])
}))
vi.mock('./loop', () => ({ startRun: h.startRun, activeRunForConversation: h.activeRun }))
vi.mock('../agentHost', () => ({ getSettings: () => ({ approvalPolicy: 'auto-edit' }) }))
// Another process's run markers (covered in runMarkers.test.ts): none unless a test says so.
vi.mock('../runMarkers', () => ({ conversationRunningElsewhere: h.runningElsewhere }))
// Auto-titling has its own tests (title.test.ts); here we only assert drain wires it
// up at turn start (plus a natural-completion fallback), so stub it out rather than reaching the provider/store.
vi.mock('./title', () => ({ maybeGenerateTitle: h.maybeGenerateTitle }))
// The suggestion call has its own tests (suggest.test.ts); here only when drain asks.
vi.mock('./suggest', () => ({ maybeSuggestNext: h.maybeSuggestNext }))
vi.mock('../conversations', () => ({
  getConversation: h.getConversation,
  setMessages: h.setMessages,
  setConversationError: h.setConversationError,
  updateConversationMeta: h.updateConversationMeta,
  takeChildReports: h.takeChildReports,
  // The queue's disk copy (covered in queue.test.ts); nothing stored here.
  getQueuedInput: () => null,
  setQueuedInput: () => {},
  resolveStoredImages: (v: unknown) => v
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
    expect(flushReq.messages).toEqual([{ role: 'user', content: 'A\n\nB', at: expect.any(String) }])
    expect(flushReq.model).toBe('m2')
    expect(flushReq.approvalPolicy).toBe('full-auto')

    expect(h.setMessages).toHaveBeenCalledWith(cid, [{ role: 'user', content: 'A\n\nB', at: expect.any(String) }], expect.objectContaining({ model: 'm2', approvalPolicy: 'full-auto' }))
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
    // Recorded in the same store write as the flushed message.
    expect(h.setMessages).toHaveBeenCalledWith(cid, [{ role: 'user', content: 'A', at: expect.any(String) }], {
      providerId: 'anthropic',
      model: 'm1',
      approvalPolicy: 'plan',
      reasoningEffort: 'low'
    })
    expect(h.updateConversationMeta).not.toHaveBeenCalled()
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
    expect(h.setMessages).toHaveBeenCalledWith(
      cid,
      [{ role: 'user', content: 'Create a GitHub pull request…', invokedAs, at: expect.any(String) }],
      expect.objectContaining({ model: 'm1' })
    )
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
    // The stored last error belongs to the run itself (startRun clears and sets it,
    // see loop.test), so the drain doesn't write it a second time.
    expect(h.setConversationError).not.toHaveBeenCalled()
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
    // As on an error, the run (not the drain) owns the stored last error.
    expect(h.setConversationError).not.toHaveBeenCalled()
    clearQueue(cid)
  })

  it('leaves the queue alone while another run or a rewind holds the chat', async () => {
    // A run the user started while the previous one's SessionEnd hooks ran: the
    // previous run's drain must not take the queue into the live run's log.
    const cid = 'conv-drain-busy'
    addToQueue({ conversationId: cid, userText: 'A', providerId: 'anthropic', model: 'm', approvalPolicy: 'ask' })
    const sink = io()
    h.activeRun.mockReturnValue('run-live')
    drainQueue(sink, cid)
    h.activeRun.mockReturnValue(null)
    let release!: () => void
    const rewind = withRewindLock(cid, null, () => new Promise<null>((r) => (release = () => r(null))))
    drainQueue(sink, cid)
    release()
    await rewind
    expect(listQueue(cid).map((q) => q.text)).toEqual(['A'])
    expect(h.setMessages).not.toHaveBeenCalled()
    expect(h.startRun).not.toHaveBeenCalled()
    expect(sink.emit).not.toHaveBeenCalled()
    expect(sink.emitQueueChanged).not.toHaveBeenCalled()
    clearQueue(cid)
  })

  it('leaves the queue alone while another Houston process runs the chat', () => {
    // That process's saves would overwrite the queued turn written into the log here,
    // and startRun would refuse the turn anyway: the queued message must stay queued.
    const cid = 'conv-drain-elsewhere'
    addToQueue({ conversationId: cid, userText: 'A', providerId: 'anthropic', model: 'm', approvalPolicy: 'ask' })
    const sink = io()
    h.runningElsewhere.mockReturnValue(4242)
    try {
      drainQueue(sink, cid)
    } finally {
      h.runningElsewhere.mockReturnValue(null)
    }
    expect(listQueue(cid).map((q) => q.text)).toEqual(['A'])
    expect(h.setMessages).not.toHaveBeenCalled()
    expect(h.startRun).not.toHaveBeenCalled()
    expect(sink.emit).not.toHaveBeenCalled()
    expect(sink.emitQueueChanged).not.toHaveBeenCalled()
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
      expect(h.startRun.mock.calls[1][0].messages).toEqual([{ role: 'user', content: 'and the docs', at: expect.any(String) }])
    })
  })

  describe('suggested next message', () => {
    const withSuggestions = () => ({ ...io(), emitSuggestion: vi.fn() })

    it('asks for one after a natural finish with nothing queued, and passes it on', async () => {
      const cid = 'conv-suggest'
      endRunsWith({ done: 'end_turn' })
      const sink = withSuggestions()
      h.maybeSuggestNext.mockImplementationOnce(async (opts) => {
        opts.onSuggestion('now add tests')
      })
      await runAndDrain(sink, cid, runReq(cid))
      await settle()
      expect(h.maybeSuggestNext).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: cid, providerId: 'anthropic', model: 'claude' })
      )
      expect(sink.emitSuggestion).toHaveBeenCalledWith(cid, 'now add tests')
    })

    it('asks for none when a queued message goes next, after an error, or for a client that shows none', async () => {
      const queued = 'conv-suggest-queued'
      addToQueue({ conversationId: queued, userText: 'A', providerId: 'anthropic', model: 'm1', approvalPolicy: 'ask' })
      endRunsWith({ done: 'end_turn' })
      await runAndDrain(withSuggestions(), queued, runReq(queued))
      await settle()
      // Only after the drained follow-up, never with a message waiting to go next.
      expect(h.maybeSuggestNext.mock.calls.filter(([o]) => o.conversationId === queued)).toHaveLength(1)
      h.maybeSuggestNext.mockClear()
      endRunsWith({ error: 'boom' })
      await runAndDrain(withSuggestions(), 'conv-suggest-error', runReq('conv-suggest-error'))
      endRunsWith({ done: 'end_turn' })
      await runAndDrain(io(), 'conv-suggest-plain', runReq('conv-suggest-plain'))
      await settle()
      expect(h.maybeSuggestNext).not.toHaveBeenCalled()
    })
  })
})

describe('startWakeTurn', () => {
  const conv = (over: Record<string, unknown> = {}) => ({
    id: 'c',
    title: 'T',
    workspace: '/ws',
    providerId: 'anthropic',
    model: 'claude',
    createdAt: 0,
    updatedAt: 0,
    messages: [{ role: 'user', content: 'build it' }],
    ...over
  })
  beforeEach(() => {
    vi.clearAllMocks()
    resetBackgroundEventsForTest()
    endRunsWith({ done: 'end_turn' })
    h.activeRun.mockReturnValue(null)
    h.takeChildReports.mockReturnValue([])
    h.getConversation.mockImplementation(() => conv({ approvalPolicy: 'ask' }))
  })
  const exit = { kind: 'shell_exit' as const, shellId: 's1', command: 'make', exitCode: 0, tail: 'ok', at: 1 }

  it("starts a wake run on the chat's own settings, opening with the note", async () => {
    pushBackgroundEvent('c', exit, { wake: false })
    const o = io()
    expect(startWakeTurn(o, 'c')).toBe(true)
    await settle()
    const req = h.startRun.mock.calls[0]![0]
    expect(req).toMatchObject({ conversationId: 'c', approvalPolicy: 'ask', wake: true, workspace: '/ws' })
    expect(req.messages.at(-1).content).toContain('background shell s1')
    expect(h.setMessages.mock.calls[0]![1].at(-1).content).toContain('the user has not sent a message')
    const start = o.emit.mock.calls.find((c) => c[1].type === 'turn_start')![1]
    expect(start).toMatchObject({ type: 'turn_start', conversationId: 'c' })
  })

  it('falls back to the default policy for a chat that never stored one', async () => {
    h.getConversation.mockImplementation(() => conv())
    pushBackgroundEvent('c', exit, { wake: false })
    expect(startWakeTurn(io(), 'c')).toBe(true)
    await settle()
    expect(h.startRun.mock.calls[0]![0].approvalPolicy).toBe('auto-edit')
  })

  it('includes finished spawned sessions', async () => {
    h.takeChildReports.mockReturnValue([{ conversationId: 'k', title: 'Child', outcome: 'done', summary: 'all good', finishedAt: 1 }])
    expect(startWakeTurn(io(), 'c')).toBe(true)
    await settle()
    expect(h.startRun.mock.calls[0]![0].messages.at(-1).content).toContain('session "Child" finished')
  })

  it('starts nothing mid-rewind and leaves the news for later', async () => {
    pushBackgroundEvent('c', exit, { wake: false })
    let started: boolean | undefined
    await withRewindLock('c', null, async () => {
      started = startWakeTurn(io(), 'c')
      return null
    })
    expect(started).toBe(false)
    expect(h.setMessages).not.toHaveBeenCalled()
    expect(h.startRun).not.toHaveBeenCalled()
    expect(hasBackgroundNews('c')).toBe(true)
  })

  it('starts nothing while another Houston process runs the chat, and keeps the news', () => {
    pushBackgroundEvent('c', exit, { wake: false })
    h.runningElsewhere.mockReturnValue(4242)
    try {
      expect(startWakeTurn(io(), 'c')).toBe(false)
    } finally {
      h.runningElsewhere.mockReturnValue(null)
    }
    expect(h.setMessages).not.toHaveBeenCalled()
    expect(h.startRun).not.toHaveBeenCalled()
    expect(h.takeChildReports).not.toHaveBeenCalled()
    expect(hasBackgroundNews('c')).toBe(true)
  })

  it('starts nothing mid-compaction, and asks for the wake again once it ends', async () => {
    // A turn started while /compact (or Summarize from here) is writing its summary
    // makes that summary unwritable, so it was thrown away.
    vi.useFakeTimers()
    try {
      setWakeHost({ enabled: () => true, start: (id) => startWakeTurn(io(), id) })
      pushBackgroundEvent('c', exit, { wake: false })
      holdCompaction('c', new AbortController())
      expect(startWakeTurn(io(), 'c')).toBe(false)
      await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS * 2)
      expect(h.startRun).not.toHaveBeenCalled()
      expect(hasBackgroundNews('c')).toBe(true)

      releaseCompaction('c')
      await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS * 2)
      expect(h.startRun).toHaveBeenCalledTimes(1)
      expect(h.startRun.mock.calls[0]![0]).toMatchObject({ conversationId: 'c', wake: true })
    } finally {
      releaseCompaction('c')
      setWakeHost(null)
      vi.useRealTimers()
    }
  })

  it('starts nothing for a running chat, a missing chat, or no news', () => {
    pushBackgroundEvent('c', exit, { wake: false })
    h.activeRun.mockReturnValue('run-1')
    expect(startWakeTurn(io(), 'c')).toBe(false)
    h.activeRun.mockReturnValue(null)
    h.getConversation.mockImplementation(() => null)
    expect(startWakeTurn(io(), 'c')).toBe(false)
    h.getConversation.mockImplementation(() => conv())
    resetBackgroundEventsForTest()
    expect(startWakeTurn(io(), 'c')).toBe(false)
    expect(h.startRun).not.toHaveBeenCalled()
  })
})
