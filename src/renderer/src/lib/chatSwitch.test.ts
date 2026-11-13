import { describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '@shared/agent'
import {
  captureEventsAfter,
  compactNotice,
  createNavSequence,
  eventsForRun,
  finishCompact,
  resendAfterRewind,
  type CompactOutcome
} from './chatSwitch'

const text = (runId: string, delta: string): AgentEvent => ({ type: 'text', runId, delta }) as AgentEvent

/** A promise plus the function that resolves it, for driving ordering by hand. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

describe('createNavSequence', () => {
  it('lets only the latest of two overlapping opens win', () => {
    const nav = createNavSequence()
    const openA = nav.begin()
    const openB = nav.begin()
    // A's reads come back last: it must not replace B.
    expect(nav.isLatest(openA)).toBe(false)
    expect(nav.isLatest(openB)).toBe(true)
  })

  it('mark notices a later navigation without being one', () => {
    const nav = createNavSequence()
    nav.begin()
    const token = nav.mark()
    expect(nav.isLatest(token)).toBe(true)
    expect(nav.isLatest(nav.mark())).toBe(true)
    nav.begin()
    expect(nav.isLatest(token)).toBe(false)
  })
})

describe('captureEventsAfter', () => {
  function bus() {
    const subs = new Set<(e: AgentEvent) => void>()
    return {
      subscribe: vi.fn((cb: (e: AgentEvent) => void) => {
        subs.add(cb)
        return () => subs.delete(cb)
      }),
      emit: (e: AgentEvent) => subs.forEach((cb) => cb(e)),
      count: () => subs.size
    }
  }

  it('keeps only what arrives after the snapshot, until taken', async () => {
    const b = bus()
    const snap = deferred<AgentEvent[]>()
    const cap = captureEventsAfter(b.subscribe, snap.promise)
    // Already in the snapshot: must not be replayed a second time.
    b.emit(text('r1', 'before'))
    snap.resolve([text('r1', 'before')])
    expect(await cap.snapshot).toEqual([text('r1', 'before')])
    // In the gap between the snapshot and adopting the run.
    b.emit(text('r1', 'gap'))
    expect(cap.take()).toEqual([text('r1', 'gap')])
    // Once taken, it stops listening.
    expect(b.count()).toBe(0)
    b.emit(text('r1', 'after'))
    expect(cap.take()).toEqual([text('r1', 'gap')])
  })

  it('unsubscribes when taken before the snapshot even resolves', () => {
    const b = bus()
    const cap = captureEventsAfter(b.subscribe, new Promise<never>(() => {}))
    expect(cap.take()).toEqual([])
    expect(b.count()).toBe(0)
  })

  it('eventsForRun keeps the adopted run’s events in order, never a turn_start', () => {
    const events = [
      text('r1', 'a'),
      text('r2', 'other chat'),
      { type: 'turn_start', runId: 'r1', conversationId: 'c1', userText: 'x' } as AgentEvent,
      { type: 'done', runId: 'r1' } as AgentEvent
    ]
    expect(eventsForRun(events, 'r1')).toEqual([text('r1', 'a'), { type: 'done', runId: 'r1' }])
  })
})

describe('finishCompact', () => {
  const compacted: CompactOutcome = { ok: true, messages: [{}], summarized: 4 }

  it('leaves the view alone when the user opened another chat meanwhile', async () => {
    const reload = vi.fn(async () => true)
    const notify = vi.fn()
    await finishCompact(compacted, { stillOpen: () => false, reload, notify })
    expect(reload).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it('reloads the compacted chat from disk, then says so there', async () => {
    const reload = vi.fn(async () => true)
    const notify = vi.fn()
    await finishCompact(compacted, { stillOpen: () => true, reload, notify })
    expect(reload).toHaveBeenCalledOnce()
    expect(notify).toHaveBeenCalledWith('Compacted 4 earlier messages.', 'info')
  })

  it('drops the notice when a navigation overtook the reload', async () => {
    const notify = vi.fn()
    await finishCompact(compacted, { stillOpen: () => true, reload: async () => false, notify })
    expect(notify).not.toHaveBeenCalled()
  })

  it('reports a failure without reloading', async () => {
    const reload = vi.fn(async () => true)
    const notify = vi.fn()
    await finishCompact({ ok: false, summarized: 0, error: 'boom' }, { stillOpen: () => true, reload, notify })
    expect(reload).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith("Couldn't compact: boom", 'error')
  })

  it('explains a chat with nothing to compact', () => {
    expect(compactNotice({ ok: true, summarized: 0, reason: 'empty' })).toBe('Nothing to compact yet.')
    expect(compactNotice({ ok: true, summarized: 0, reason: 'single-turn' })).toMatch(/single turn/)
  })
})

describe('resendAfterRewind', () => {
  function deps(over: Partial<Parameters<typeof resendAfterRewind>[0]> = {}) {
    return {
      stillOpen: vi.fn(() => true),
      reload: vi.fn(async () => true),
      sendInView: vi.fn(),
      sendDetached: vi.fn(async () => true),
      giveBack: vi.fn(),
      ...over
    }
  }

  it('sends in view when the user is still on the chat', async () => {
    const d = deps()
    expect(await resendAfterRewind(d)).toBe('view')
    expect(d.reload).toHaveBeenCalledOnce()
    expect(d.sendInView).toHaveBeenCalledOnce()
    expect(d.sendDetached).not.toHaveBeenCalled()
  })

  it('still sends to the rewound chat when the user moved away, without reloading it into view', async () => {
    const d = deps({ stillOpen: vi.fn(() => false) })
    expect(await resendAfterRewind(d)).toBe('detached')
    expect(d.reload).not.toHaveBeenCalled()
    expect(d.sendInView).not.toHaveBeenCalled()
    expect(d.sendDetached).toHaveBeenCalledOnce()
  })

  it('sends detached when a navigation overtook the reload', async () => {
    const d = deps({ reload: vi.fn(async () => false) })
    expect(await resendAfterRewind(d)).toBe('detached')
    expect(d.sendInView).not.toHaveBeenCalled()
  })

  it('gives the message back when it could not be started anywhere', async () => {
    const d = deps({ stillOpen: vi.fn(() => false), sendDetached: vi.fn(async () => false) })
    expect(await resendAfterRewind(d)).toBe('given-back')
    expect(d.giveBack).toHaveBeenCalledOnce()
  })
})
