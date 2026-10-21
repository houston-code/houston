import {
  COMPACTION_SUMMARY_PREFIX,
  SYSTEM_NOTE_PREFIX,
  type ChatMessage,
  type ConversationCompaction
} from './agent'
import { invocationText } from './promptInvocation'

/**
 * Rewind: take a conversation back to just before one of the user's earlier
 * messages. Shared by the main-process implementation (agent/rewind.ts), the GUI,
 * and the TUI, so all three agree on which messages are rewind points and how a
 * point is named.
 *
 * - `conversation`: drop that message and everything after it; files stay as they are.
 * - `code`: put back the files the agent changed from that turn on; the chat stays.
 * - `both`: do both.
 */
export type RewindMode = 'conversation' | 'code' | 'both'

export const REWIND_MODES: readonly RewindMode[] = ['both', 'conversation', 'code']

export function isRewindMode(v: unknown): v is RewindMode {
  return v === 'conversation' || v === 'code' || v === 'both'
}

export function rewindsConversation(mode: RewindMode): boolean {
  return mode !== 'code'
}

export function rewindsCode(mode: RewindMode): boolean {
  return mode !== 'conversation'
}

/**
 * Whether a message is a turn the user can rewind to: something they sent, which
 * started (or retried) a run. Excludes the turns Houston writes on the user role
 * (automated notes, the compaction summary) and a message steered into a running
 * turn, which belongs to the turn it was steered into. Mirrors the GUI's user
 * bubbles (itemsFromMessages), so the Nth bubble is the Nth rewind point.
 */
export function isRewindableTurn(m: ChatMessage): boolean {
  if (m.role !== 'user') return false
  if (m.steered === true) return false
  if (m.content.startsWith(SYSTEM_NOTE_PREFIX)) return false
  if (m.content.startsWith(COMPACTION_SUMMARY_PREFIX)) return false
  return m.content.trim() !== '' || (m.images?.length ?? 0) > 0
}

/** Message indices of every rewind point, oldest first. Index `n` here is turn `n`. */
export function rewindableTurnIndices(messages: ChatMessage[]): number[] {
  const out: number[] = []
  messages.forEach((m, i) => {
    if (isRewindableTurn(m)) out.push(i)
  })
  return out
}

/**
 * What the user wrote for a turn: the command they typed for an invoked turn
 * (`/review`), never the prompt Houston expanded it to. Used to put a rewound
 * message back in the composer and to label it in pickers.
 */
export function turnText(m: ChatMessage): string {
  return m.invokedAs ? invocationText(m.invokedAs) : m.content
}

/** One line naming a turn in a picker. */
export function turnLabel(m: ChatMessage, max = 72): string {
  const flat = turnText(m).replace(/\s+/g, ' ').trim()
  const text = flat || (m.images?.length ? '(image)' : '(empty)')
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** A rewind point as a picker lists it. */
export interface RewindPoint {
  /** Position among the rewind points (0 = the first message). */
  turn: number
  /** Index of the message in the conversation's log. */
  messageIndex: number
  label: string
}

export function rewindPoints(messages: ChatMessage[]): RewindPoint[] {
  return rewindableTurnIndices(messages).map((messageIndex, turn) => ({
    turn,
    messageIndex,
    label: turnLabel(messages[messageIndex])
  }))
}

/**
 * The compaction state that stays valid once the log is cut to `messages[0..at)`
 * (the user message at `at` and everything after it removed). Pure.
 *
 * The summary stands in for `messages[0..cut)`; it survives only when all of that
 * is kept (`cut <= at`). A cut inside a turn (`anchor` set) needs the assistant
 * message at `cut`, so it survives only when `cut < at`. The eviction watermark is
 * clamped to the new length. Anything that survives none of this is dropped (null),
 * and the next run re-summarizes from scratch rather than resuming from a summary of
 * messages that are gone.
 */
export function compactionAfterTruncate(
  compaction: ConversationCompaction | undefined,
  at: number
): ConversationCompaction | null {
  if (!compaction) return null
  const evict =
    compaction.evictBefore !== undefined ? Math.min(compaction.evictBefore, at) : undefined
  const keepSummary =
    compaction.cut > 0 &&
    (compaction.anchor === undefined ? compaction.cut <= at : compaction.cut < at)
  if (keepSummary) {
    return {
      cut: compaction.cut,
      summary: compaction.summary,
      ...(compaction.anchor !== undefined ? { anchor: compaction.anchor } : {}),
      ...(evict !== undefined && evict > 0 ? { evictBefore: evict } : {})
    }
  }
  return evict !== undefined && evict > 0 ? { cut: 0, summary: '', evictBefore: evict } : null
}

/** What a rewind would do, shown in the confirmation before anything changes. */
export interface RewindPreview {
  /** User turns removed from the chat (conversation modes), counting the target. */
  turns: number
  /** Distinct files whose changes would be put back (code modes). */
  files: number
  /** Files changed since the agent wrote them, which a code rewind would leave alone. */
  conflicts: string[]
  /** Turns that changed files whose snapshots are no longer kept (too old). */
  unavailable: number
}

export type RewindPreviewResult = ({ ok: true } & RewindPreview) | { ok: false; error: string }

export interface RewindOutcome {
  /** The conversation's log after the rewind (unchanged for `code`). */
  messages: ChatMessage[]
  /** What the user wrote in the target message, to put back in the composer. */
  text: string
  /** Files put back to their earlier content. */
  restored: number
  /** Files left alone because they changed outside the agent since (relative paths). */
  conflicts: string[]
  /** Turns whose file changes could not be put back (snapshots no longer kept). */
  unavailable: number
  /** Whether the rewind can still be undone (until the next message). */
  undoable: boolean
}

export type RewindResult = ({ ok: true } & RewindOutcome) | { ok: false; error: string }

export interface UndoRewindOutcome {
  messages: ChatMessage[]
  /** Files put back to what the agent had written. */
  reapplied: number
  conflicts: string[]
}

export type UndoRewindResult = ({ ok: true } & UndoRewindOutcome) | { ok: false; error: string }

/** Plural helper for the copy below. */
function n(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

/**
 * The confirmation text both clients show. States what changes and the one thing
 * rewind can't do: undo what shell commands did.
 */
export function rewindConfirmText(mode: RewindMode, p: RewindPreview): string {
  const parts: string[] = []
  if (rewindsConversation(mode)) {
    parts.push(
      p.turns === 1
        ? 'Removes this message and the replies after it.'
        : `Removes ${p.turns} messages you sent, from this one on, and the replies to them.`
    )
  }
  if (rewindsCode(mode)) {
    parts.push(
      p.files > 0
        ? `Restores ${n(p.files, 'file')} the agent changed.`
        : 'The agent changed no files it can restore from this point.'
    )
    if (p.conflicts.length > 0) {
      parts.push(
        `${n(p.conflicts.length, 'file')} changed since the agent wrote ${p.conflicts.length === 1 ? 'it' : 'them'} and will be left as ${p.conflicts.length === 1 ? 'it is' : 'they are'}: ${p.conflicts.slice(0, 5).join(', ')}${p.conflicts.length > 5 ? ', …' : ''}.`
      )
    }
    if (p.unavailable > 0) {
      parts.push(`${n(p.unavailable, 'earlier turn')} can't be restored (snapshots no longer kept).`)
    }
    parts.push("Changes made by shell commands aren't tracked and won't be undone.")
  }
  return parts.join(' ')
}

/** One-line summary of a finished rewind, for a notice. */
export function rewindDoneText(mode: RewindMode, r: RewindOutcome): string {
  const parts: string[] = []
  if (rewindsConversation(mode)) parts.push('Rewound the conversation.')
  if (rewindsCode(mode)) parts.push(`Restored ${n(r.restored, 'file')}.`)
  if (r.conflicts.length > 0) {
    parts.push(`Left ${n(r.conflicts.length, 'file')} that changed outside the agent: ${r.conflicts.slice(0, 5).join(', ')}${r.conflicts.length > 5 ? ', …' : ''}.`)
  }
  if (r.unavailable > 0) parts.push(`${n(r.unavailable, 'turn')} had no snapshots left to restore.`)
  return parts.join(' ')
}
