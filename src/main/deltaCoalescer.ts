import type { AgentEvent } from '@shared/agent'

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

/** Every coalescer that may be holding a delta, so a state read can drain them first. */
const holding = new Set<DeltaCoalescer>()

/**
 * Forward every held delta in every live run. Call before answering a request that
 * returns run or chat state (the live transcript, the saved conversation): a window
 * that reads that state and then receives a delta from before it would show the text
 * twice.
 */
export function flushAllDeltas(): void {
  for (const c of [...holding]) c.flush()
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

/** For tests: drop the registry of coalescers holding a delta. */
export function resetDeltaCoalescers(): void {
  holding.clear()
}
