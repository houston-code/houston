import { afterEach, describe, expect, it } from 'vitest'
import type { AgentEvent } from '@shared/agent'
import {
  createDeltaCoalescer,
  createWindowEventGate,
  flushAllDeltas,
  HIDDEN_WINDOW_COALESCE_MS,
  resetDeltaCoalescers,
  type CoalescerTimers
} from './deltaCoalescer'

/** Timers the test fires by hand. */
function manualTimers(): CoalescerTimers & { fire: () => void; pending: () => number } {
  let queue: Array<{ id: number; fn: () => void }> = []
  let next = 1
  return {
    set: (fn) => {
      const id = next++
      queue.push({ id, fn })
      return id
    },
    clear: (h) => {
      queue = queue.filter((t) => t.id !== h)
    },
    fire: () => {
      const due = queue
      queue = []
      for (const t of due) t.fn()
    },
    pending: () => queue.length
  }
}

const text = (delta: string, runId = 'r1'): AgentEvent => ({ runId, type: 'text', delta })
const reasoning = (delta: string, runId = 'r1'): AgentEvent => ({ runId, type: 'reasoning', delta })
const done = (runId = 'r1'): AgentEvent => ({ runId, type: 'done', stopReason: 'end_turn' })

afterEach(() => resetDeltaCoalescers())

describe('delta coalescer', () => {
  it('forwards the first delta at once and merges the ones that follow in the window', () => {
    const out: AgentEvent[] = []
    const timers = manualTimers()
    const c = createDeltaCoalescer((e) => out.push(e), timers)
    c.push(text('Hel'))
    expect(out).toEqual([text('Hel')])
    c.push(text('lo'))
    c.push(text(', '))
    c.push(text('world'))
    expect(out).toHaveLength(1)
    timers.fire()
    expect(out).toEqual([text('Hel'), text('lo, world')])
  })

  it('keeps gathering across windows while text keeps coming, and stops when it goes quiet', () => {
    const out: AgentEvent[] = []
    const timers = manualTimers()
    const c = createDeltaCoalescer((e) => out.push(e), timers)
    c.push(text('a'))
    c.push(text('b'))
    timers.fire()
    c.push(text('c'))
    // Still inside a window, so held rather than sent alone.
    expect(out).toEqual([text('a'), text('b')])
    timers.fire()
    expect(out).toEqual([text('a'), text('b'), text('c')])
    // Nothing was held this time: the window closes and no timer is left running.
    timers.fire()
    expect(timers.pending()).toBe(0)
    c.push(text('d'))
    expect(out[out.length - 1]).toEqual(text('d'))
  })

  it('never lets another event overtake held text', () => {
    const out: AgentEvent[] = []
    const timers = manualTimers()
    const c = createDeltaCoalescer((e) => out.push(e), timers)
    c.push(text('one'))
    c.push(text(' two'))
    c.push(done())
    expect(out).toEqual([text('one'), text(' two'), done()])
  })

  it('does not merge text into reasoning, or one run into another', () => {
    const out: AgentEvent[] = []
    const timers = manualTimers()
    const c = createDeltaCoalescer((e) => out.push(e), timers)
    c.push(reasoning('think'))
    c.push(reasoning('ing'))
    c.push(text('answer'))
    c.push(text('!', 'r2'))
    timers.fire()
    expect(out).toEqual([reasoning('think'), reasoning('ing'), text('answer'), text('!', 'r2')])
  })

  it('delivers the same text as sending every delta on its own', () => {
    let seed = 11
    const rnd = (): number => ((seed = (seed * 1664525 + 1013904223) >>> 0), seed / 2 ** 32)
    const out: AgentEvent[] = []
    const timers = manualTimers()
    const c = createDeltaCoalescer((e) => out.push(e), timers)
    const sent: AgentEvent[] = []
    for (let i = 0; i < 500; i++) {
      const r = rnd()
      const e = r < 0.7 ? text(`t${i} `) : r < 0.9 ? reasoning(`r${i} `) : done()
      sent.push(e)
      c.push(e)
      if (rnd() < 0.2) timers.fire()
    }
    c.flush()
    // Rejoin runs of same-type deltas on both sides: the streams must then be equal.
    const join = (events: AgentEvent[]): AgentEvent[] => {
      const joined: AgentEvent[] = []
      for (const e of events) {
        const last = joined[joined.length - 1]
        if (last && (e.type === 'text' || e.type === 'reasoning') && last.type === e.type) {
          joined[joined.length - 1] = { ...last, delta: last.delta + e.delta }
        } else joined.push(e)
      }
      return joined
    }
    expect(join(out)).toEqual(join(sent))
    expect(out.length).toBeLessThan(sent.length)
  })

  it('flushAllDeltas drains every run that is holding text', () => {
    const a: AgentEvent[] = []
    const b: AgentEvent[] = []
    const timers = manualTimers()
    const ca = createDeltaCoalescer((e) => a.push(e), timers)
    const cb = createDeltaCoalescer((e) => b.push(e), timers)
    ca.push(text('a1'))
    ca.push(text('a2'))
    cb.push(text('b1', 'r2'))
    cb.push(text('b2', 'r2'))
    flushAllDeltas()
    expect(a).toEqual([text('a1'), text('a2')])
    expect(b).toEqual([text('b1', 'r2'), text('b2', 'r2')])
    // Nothing is sent twice when the window then ends.
    timers.fire()
    expect(a).toHaveLength(2)
    expect(b).toHaveLength(2)
  })
})

describe('window event gate', () => {
  const toolStart = (callId: string): AgentEvent => ({ runId: 'r1', type: 'tool_start', callId, name: 'read_file', args: {} })
  const approval: AgentEvent = {
    runId: 'r1',
    type: 'tool_approval',
    callId: 'w1',
    name: 'write_file',
    summary: 'write a.txt',
    kind: 'write'
  }

  function gate(visible: boolean) {
    const batches: AgentEvent[][] = []
    const timers = manualTimers()
    const state = { visible }
    const g = createWindowEventGate((events) => batches.push(events), () => state.visible, timers)
    return { g, batches, timers, state }
  }

  it('sends each event as it comes while the window is visible', () => {
    const { g, batches, timers } = gate(true)
    g.push(text('a'))
    g.push(toolStart('t1'))
    g.push(text('b'))
    expect(batches).toEqual([[text('a')], [toolStart('t1')], [text('b')]])
    expect(timers.pending()).toBe(0)
  })

  it('holds a hidden window’s events and sends them as one batch, in order, deltas joined', () => {
    const { g, batches, timers } = gate(false)
    g.push(text('Hel'))
    g.push(text('lo'))
    g.push(reasoning('hm'))
    g.push(toolStart('t1'))
    g.push(text(' again'))
    g.push(text('!'))
    expect(batches).toEqual([])
    expect(timers.pending()).toBe(1)
    timers.fire()
    expect(batches).toEqual([[text('Hello'), reasoning('hm'), toolStart('t1'), text(' again!')]])
    // Nothing more until something new arrives.
    timers.fire()
    expect(batches).toHaveLength(1)
  })

  it('sends what needs the user at once, after what was held', () => {
    for (const urgent of [approval, done(), { runId: 'r1', type: 'error', message: 'boom' } as AgentEvent]) {
      const { g, batches, timers } = gate(false)
      g.push(text('let me '))
      g.push(text('write'))
      g.push(urgent)
      expect(batches).toEqual([[text('let me write'), urgent]])
      expect(timers.pending()).toBe(0)
    }
    // Nothing held: it goes alone.
    const { g, batches } = gate(false)
    g.push(approval)
    expect(batches).toEqual([[approval]])
  })

  it('sends what was held when the window is shown, before anything newer', () => {
    const { g, batches, state } = gate(false)
    g.push(text('while '))
    g.push(text('away'))
    state.visible = true
    g.flush()
    expect(batches).toEqual([[text('while away')]])
    g.push(text('back'))
    expect(batches).toEqual([[text('while away')], [text('back')]])
    // Shown without a show event (the gate only sees it on the next event): still in order.
    const late = gate(false)
    late.g.push(text('held'))
    late.state.visible = true
    late.g.push(text('next'))
    expect(late.batches).toEqual([[text('held'), text('next')]])
  })

  it('is drained by flushAllDeltas, including what a coalescer hands it while draining', () => {
    const { g, batches, timers } = gate(false)
    const c = createDeltaCoalescer((e) => g.push(e), timers)
    c.push(text('a'))
    c.push(text('b'))
    // The coalescer still holds 'b' and the gate holds 'a': one call sends both, in order,
    // and leaves nothing held for later (which would show it twice after a state read).
    flushAllDeltas()
    expect(batches.flat()).toEqual([text('a'), text('b')])
    timers.fire()
    expect(batches.flat()).toHaveLength(2)
  })

  it('waits the hidden window interval', () => {
    expect(HIDDEN_WINDOW_COALESCE_MS).toBeGreaterThanOrEqual(250)
    expect(HIDDEN_WINDOW_COALESCE_MS).toBeLessThanOrEqual(500)
  })
})
