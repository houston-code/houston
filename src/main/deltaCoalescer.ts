import { BLOCKING_EVENT_TYPES, type AgentEvent } from '@shared/agent'

/**
 * Merges a run's streamed text and reasoning deltas before they reach a window.
 *
 * A fast model streams hundreds of deltas a second, and each one sent on its own is an
 * IPC message, a copy across the context bridge, and a full React render of the chat.
 * Nothing on screen can change faster than the display refreshes, so deltas that arrive
 * inside one window are joined into a single event of the same type.
 *
 * What stays exactly as before:
 * - The first delta after a quiet spell is forwarded at once, so nothing is added to the
 *   time to the first visible token.
 * - Order. Any other event flushes what is held before it is forwarded, so a tool call,
 *   a `turn_discarded` (which retracts text by length) or the end of the run never
 *   overtakes the text that came before it.
 * - The text itself: joined deltas concatenate to the same string.
 *
 * Only the desktop windows use this. The terminal clients and ACP consume the loop's
 * events directly.
 */

/** How long deltas are gathered before one merged event is forwarded. */
export const DELTA_COALESCE_MS = 24

type DeltaEvent = Extract<AgentEvent, { type: 'text' | 'reasoning' }>

function isDelta(e: AgentEvent): e is DeltaEvent {
  return e.type === 'text' || e.type === 'reasoning'
}

export interface DeltaCoalescer {
  /** Take one event from the run: forward it now, or hold it to merge with the next. */
  push(e: AgentEvent): void
  /** Forward anything held, now. */
  flush(): void
}

export interface CoalescerTimers {
  set: (fn: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

const realTimers: CoalescerTimers = {
  set: (fn, ms) => {
    const t = setTimeout(fn, ms)
    // A held delta must never keep the process alive on its own.
    t.unref?.()
    return t
  },
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
}

/**
 * Every coalescer (and hidden window's gate) that may be holding an event, so a state
 * read can drain them first.
 */
const holding = new Set<{ flush(): void }>()

/**
 * Forward every held delta in every live run, and send every event a hidden window is
 * holding. Call before answering a request that returns run or chat state (the live
 * transcript, the saved conversation): a window that reads that state and then
 * receives a delta from before it would show the text twice.
 */
export function flushAllDeltas(): void {
  // A coalescer's flush can hand its delta to a hidden window's gate, which holds it
  // in turn, so go round until nothing holds anything (a gate only ever sends).
  for (let pass = 0; pass < 3 && holding.size > 0; pass++) {
    for (const c of [...holding]) c.flush()
  }
}

export function createDeltaCoalescer(
  forward: (e: AgentEvent) => void,
  timers: CoalescerTimers = realTimers,
  windowMs: number = DELTA_COALESCE_MS
): DeltaCoalescer {
  let held: DeltaEvent | null = null
  /** Set while a gathering window is open; deltas arriving meanwhile are held. */
  let timer: unknown = null

  const open = (): void => {
    timer = timers.set(onWindowEnd, windowMs)
  }
  const flush = (): void => {
    if (!held) return
    const e = held
    held = null
    holding.delete(self)
    forward(e)
  }
  function onWindowEnd(): void {
    timer = null
    if (!held) return
    flush()
    // More text is likely right behind: keep gathering rather than send the next
    // delta alone.
    open()
  }

  const self: DeltaCoalescer = {
    push(e) {
      if (!isDelta(e)) {
        flush()
        forward(e)
        return
      }
      if (timer === null) {
        // Quiet until now: show it immediately, then gather what follows.
        forward(e)
        open()
        return
      }
      if (held && held.type === e.type && held.runId === e.runId) {
        held = { ...held, delta: held.delta + e.delta }
        return
      }
      flush()
      held = e
      holding.add(self)
    },
    flush
  }
  return self
}

/** How long a window that can't be seen gathers a run's events before sending them. */
export const HIDDEN_WINDOW_COALESCE_MS = 400

/**
 * What a hidden window still gets the moment it happens: a prompt waiting on the user
 * and the end of the run (or its failure), so whatever brings the window back (often a
 * notification for exactly that) finds it already there.
 */
function sendsAtOnce(e: AgentEvent): boolean {
  return (BLOCKING_EVENT_TYPES as readonly string[]).includes(e.type) || e.type === 'done' || e.type === 'error'
}

export interface WindowEventGate {
  /** Take one event for the window: send it now, or hold it while the window is hidden. */
  push(e: AgentEvent): void
  /** Send everything held, now (the window was shown again). */
  flush(): void
}

/**
 * Paces one window's run events by whether it can be seen. A visible window gets each
 * event as it comes, exactly as before. A hidden or minimized one would otherwise still
 * render the chat for every merged delta, so its events are held and sent together
 * every {@link HIDDEN_WINDOW_COALESCE_MS}, in order, with consecutive deltas joined;
 * `send` gets them as one batch, for one render. Anything that needs the user goes at
 * once (after what is held), and showing the window sends what is held (`flush`).
 * Desktop notifications don't pass through here, so they are unaffected.
 */
export function createWindowEventGate(
  send: (events: AgentEvent[]) => void,
  visible: () => boolean,
  timers: CoalescerTimers = realTimers,
  windowMs: number = HIDDEN_WINDOW_COALESCE_MS
): WindowEventGate {
  let held: AgentEvent[] = []
  let timer: unknown = null

  const flush = (): void => {
    if (timer !== null) {
      timers.clear(timer)
      timer = null
    }
    if (held.length === 0) return
    const out = held
    held = []
    holding.delete(self)
    send(out)
  }

  const self: WindowEventGate = {
    push(e) {
      if (sendsAtOnce(e) || visible()) {
        if (held.length === 0) return send([e])
        held.push(e)
        return flush()
      }
      const last = held[held.length - 1]
      if (last && isDelta(e) && isDelta(last) && last.type === e.type && last.runId === e.runId) {
        held[held.length - 1] = { ...last, delta: last.delta + e.delta }
      } else {
        held.push(e)
      }
      holding.add(self)
      if (timer === null) timer = timers.set(flush, windowMs)
    },
    flush
  }
  return self
}

/** For tests: drop the registry of coalescers holding a delta. */
export function resetDeltaCoalescers(): void {
  holding.clear()
}
