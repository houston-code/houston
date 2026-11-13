import type { AgentEvent } from '@shared/agent'

/**
 * Guards for async work that ends by acting on "the open chat". Opening a chat,
 * compacting it, rewinding it, or creating one all await the main process, and the
 * user can click another chat in the sidebar meanwhile. A continuation that then
 * resets the transcript or sends a turn would land on whatever chat is showing by
 * then, mixing two chats. These helpers keep each continuation tied to the chat that
 * started it.
 */

/**
 * A counter bumped by every navigation (opening a chat, the new-chat screen). Work
 * that started under one value and finds another has been overtaken: a slower open
 * must not replace the chat the user clicked after it.
 */
export interface NavSequence {
  /** Record a navigation; returns its token. */
  begin: () => number
  /** The latest token, for work that must notice a later navigation without being one. */
  mark: () => number
  /** True while nothing has navigated since `token`. */
  isLatest: (token: number) => boolean
}

export function createNavSequence(): NavSequence {
  let n = 0
  return {
    begin: () => ++n,
    mark: () => n,
    isLatest: (token) => token === n
  }
}

/**
 * Collect the agent events that arrive after `snapshot` resolves, until `take` is
 * called. Opening a chat whose run is streaming reads a snapshot of the run's output
 * (getLiveTranscript), then waits on its other reads before it adopts the run; events
 * in that gap are in neither the snapshot nor the adopted stream, so they would be
 * lost. IPC replies and events come down one ordered channel, so everything that
 * arrived before the snapshot resolved is already in it and nothing is counted twice.
 */
export function captureEventsAfter<T>(
  subscribe: (cb: (e: AgentEvent) => void) => () => void,
  snapshot: Promise<T>
): { snapshot: Promise<T>; take: () => AgentEvent[] } {
  const events: AgentEvent[] = []
  let capturing = false
  let stopped = false
  const unsubscribe = subscribe((e) => {
    if (capturing && !stopped) events.push(e)
  })
  const tracked = snapshot.then((v) => {
    capturing = true
    return v
  })
  return {
    snapshot: tracked,
    take: () => {
      if (!stopped) {
        stopped = true
        unsubscribe()
      }
      return events
    }
  }
}

/** The events of `runId` from a capture, in order, to replay after adopting it. */
export function eventsForRun(events: AgentEvent[], runId: string): AgentEvent[] {
  return events.filter((e) => e.type !== 'turn_start' && e.runId === runId)
}

export interface CompactOutcome {
  ok: boolean
  messages?: unknown[]
  summarized: number
  reason?: string
  error?: string
}

/** What to say after a compaction, by its result. */
export function compactNotice(res: CompactOutcome): string {
  if (res.ok && res.messages) return `Compacted ${res.summarized} earlier messages.`
  if (res.ok) {
    return res.reason === 'single-turn'
      ? 'This conversation is a single turn, so there are no earlier turns to summarize. Start a new chat to free up context.'
      : 'Nothing to compact yet.'
  }
  return `Couldn't compact: ${res.error ?? 'unknown error'}`
}

export interface ReopenDeps {
  /** Whether the chat the work started in is still the one in view. */
  stillOpen: () => boolean
  /** Rebuild that chat's view from what main stored; false when overtaken by a navigation. */
  reload: () => Promise<boolean>
  /** A transcript notice in that chat. */
  notify: (text: string, tone: 'info' | 'error') => void
}

/**
 * Finish a compaction. The compacted chat is rebuilt from disk (transcript, usage,
 * checkpoint, a live run) only while the user is still on it, and its notice goes
 * there too; a user who has moved to another chat sees the result when they return.
 */
export async function finishCompact(res: CompactOutcome, d: ReopenDeps): Promise<void> {
  if (!d.stillOpen()) return
  if (res.ok && res.messages) {
    if (!(await d.reload()) || !d.stillOpen()) return
  }
  d.notify(compactNotice(res), res.ok ? 'info' : 'error')
}

export interface ResendDeps {
  stillOpen: () => boolean
  reload: () => Promise<boolean>
  /** Send in the open chat's view (it streams there). */
  sendInView: () => void
  /** Start the turn in the chat without taking over the view; false when it failed. */
  sendDetached: () => Promise<boolean>
  /** Nothing took it: put the text back in its chat's message box. */
  giveBack: () => void
}

/**
 * After a rewind for Retry, send the rewound message again in the chat it belongs to.
 * Still on that chat, it is reloaded and the turn streams in view as usual; moved
 * elsewhere, the turn starts there in the background and the open chat is left alone.
 * The message is never dropped: if it can't be started, it goes back to its box.
 */
export async function resendAfterRewind(d: ResendDeps): Promise<'view' | 'detached' | 'given-back'> {
  if (d.stillOpen() && (await d.reload()) && d.stillOpen()) {
    d.sendInView()
    return 'view'
  }
  if (await d.sendDetached()) return 'detached'
  d.giveBack()
  return 'given-back'
}
