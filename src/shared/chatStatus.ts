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

/** The live state of one conversation, as the main process sees it. */
export interface ChatLiveStatus {
  running: boolean
  /** Prompts the live run is blocked on, oldest first. Empty when nothing is waiting. */
  pending: PendingPrompt[]
}

/**
 * Live state per conversation id. Only conversations with something live appear:
 * an absent id is idle, so the map stays small however many chats exist.
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
