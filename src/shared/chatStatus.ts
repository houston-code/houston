/**
 * What a chat row in the sidebar signals about its conversation, and the one place
 * that decides it.
 *
 * The main process owns the live facts (is a run going, what is it blocked on), so
 * it broadcasts a {@link ChatStatusMap}; every surface that shows a chat's state (the
 * row dot, a folded parent, a group header) folds those facts through
 * {@link chatSignal} and {@link strongestSignal} so they can never disagree about
 * which state wins. Pure and Electron-free, like `notify.ts`, so the terminal client
 * can show the same thing.
 */

import type { ChatMessage } from './agent'

/**
 * Whether a message shows in the transcript as an assistant reply (text, or reasoning
 * alone). The transcript and the unread anchor both count replies with this, so "the
 * Nth reply" names the same message on either side of IPC.
 */
export function rendersAsReply(m: ChatMessage): boolean {
  if (m.role !== 'assistant') return false
  return m.content.trim() !== '' || (m.reasoning?.some((r) => r.text) ?? false)
}

/** The log index of each message that renders as an assistant reply, in order. */
export function replyMessageIndexes(messages: readonly ChatMessage[]): number[] {
  const out: number[] = []
  messages.forEach((m, i) => {
    if (rendersAsReply(m)) out.push(i)
  })
  return out
}

/** The kinds of prompt a live run can block on until the user answers. */
export type PendingKind = 'approval' | 'question' | 'plan' | 'elicitation'

/** One prompt blocking a run, reduced to what a sidebar row needs to describe it. */
export interface PendingPrompt {
  kind: PendingKind
  /**
   * A short subject: the tool name for an approval, the plan's title, the MCP server
   * asking. Absent for a question (the question text is too long for a row).
   */
  label?: string
}

/** How the turn behind an unread mark ended, or that the user marked it by hand. */
export type UnreadOutcome = 'done' | 'limit' | 'error' | 'manual'

/**
 * A chat the user hasn't seen since its last turn finished (or that they marked
 * unread). Kept by the main process across restarts.
 */
export interface UnreadInfo {
  /** Epoch ms the chat became unread. */
  since: number
  outcome: UnreadOutcome
  /** A short line describing what's new: an opened PR, or the error a run failed on. */
  note?: string
  /**
   * Index in the conversation's message log where the unseen part starts (the
   * finished turn's first message, or the reply the user marked unread from). The
   * transcript scrolls there with a "New" divider on the next open.
   */
  anchor?: number
}

/** The state of one conversation, as the main process sees it. */
export interface ChatLiveStatus {
  running: boolean
  /** Prompts the live run is blocked on, oldest first. Empty when nothing is waiting. */
  pending: PendingPrompt[]
  /** Present while the chat has something the user hasn't seen. */
  unread?: UnreadInfo
}

/**
 * State per conversation id. Only conversations with something to show appear (a
 * live run, or something unseen): an absent id is idle and read, so the map stays
 * small however many chats exist.
 */
export type ChatStatusMap = Record<string, ChatLiveStatus>

/**
 * The one signal a chat row shows, highest priority first:
 * - `input`: the run is blocked on the user (approval, question, plan, elicitation).
 * - `error`: the last run failed and the user has not looked at it yet.
 * - `working`: a run is live and nothing is waiting on the user.
 * - `unread`: a turn finished while the user wasn't looking, or they marked it unread.
 * - `idle`: nothing to show.
 */
export type ChatSignal = 'input' | 'error' | 'working' | 'unread' | 'idle'

/** Signals ordered strongest first; an aggregate shows the first one present. */
export const SIGNAL_PRIORITY: readonly ChatSignal[] = ['input', 'error', 'working', 'unread', 'idle']

/**
 * The signal for one chat. `failed` and `unread` come from read state (has the user
 * seen the latest outcome); `active` is true for the chat open in a focused window,
 * which never shows `error` or `unread` because the user is looking at it.
 */
export function chatSignal(
  live: ChatLiveStatus | undefined,
  opts: { failed?: boolean; unread?: boolean; active?: boolean } = {}
): ChatSignal {
  if (live && live.pending.length > 0) return 'input'
  if (opts.failed && !opts.active) return 'error'
  if (live?.running) return 'working'
  if (opts.unread && !opts.active) return 'unread'
  return 'idle'
}

/** The strongest of several signals (for a folded parent or a section header). */
export function strongestSignal(signals: Iterable<ChatSignal>): ChatSignal {
  let best = SIGNAL_PRIORITY.length - 1
  for (const s of signals) {
    const i = SIGNAL_PRIORITY.indexOf(s)
    if (i < best) best = i
  }
  return SIGNAL_PRIORITY[best]
}

/**
 * The reason a blocked chat shows in its row's meta line, e.g. "Needs approval:
 * run_shell". Several prompts of one kind collapse to a count; a mix to a total.
 * Undefined when nothing is pending.
 */
export function pendingReason(pending: readonly PendingPrompt[]): string | undefined {
  if (pending.length === 0) return undefined
  const kinds = new Set(pending.map((p) => p.kind))
  if (kinds.size > 1) return `${pending.length} prompts waiting`
  const [first] = pending
  const n = pending.length
  switch (first.kind) {
    case 'approval':
      if (n > 1) return `${n} approvals waiting`
      return first.label ? `Needs approval: ${first.label}` : 'Needs approval'
    case 'question':
      return n > 1 ? `${n} questions waiting` : 'Has a question'
    case 'plan':
      return 'Plan ready for review'
    case 'elicitation':
      if (n > 1) return `${n} input requests waiting`
      return first.label ? `${first.label} is asking for input` : 'Server is asking for input'
  }
}

/**
 * The signal for a chat from its status entry alone: failed and unread come from its
 * unread mark (a failed run is an unread one whose outcome was an error).
 */
export function statusSignal(status: ChatLiveStatus | undefined, active: boolean): ChatSignal {
  return chatSignal(status, {
    failed: status?.unread?.outcome === 'error',
    unread: status?.unread !== undefined,
    active
  })
}

/**
 * The meta-line reason for a chat's signal, or undefined when the signal speaks for
 * itself (working, idle).
 */
export function signalReason(status: ChatLiveStatus | undefined, signal: ChatSignal): string | undefined {
  if (!status) return undefined
  if (signal === 'input') return pendingReason(status.pending)
  const u = status.unread
  if (!u || (signal !== 'error' && signal !== 'unread')) return undefined
  switch (u.outcome) {
    case 'error':
      return u.note ? `Failed: ${u.note}` : 'Failed'
    case 'limit':
      return u.note ?? 'Stopped at step limit'
    case 'manual':
      return 'Marked unread'
    case 'done':
      return u.note ?? 'Finished'
  }
}

/** The accessible name for a signal's dot (read by screen readers and the tooltip). */
export function signalLabel(signal: ChatSignal): string | undefined {
  switch (signal) {
    case 'input':
      return 'Needs input'
    case 'error':
      return 'Failed'
    case 'working':
      return 'Working'
    case 'unread':
      return 'Unread'
    case 'idle':
      return undefined
  }
}
