import type { ChatMessage, Conversation, RewindBackup } from '@shared/agent'
import {
  compactionAfterTruncate,
  rewindableTurnIndices,
  rewindsCode,
  rewindsConversation,
  turnText,
  type RewindMode,
  type RewindPreviewResult,
  type RewindResult,
  type UndoRewindResult
} from '@shared/rewind'
import { getConversation, peekConversation, writeRewind } from '../conversations'
import {
  conversationChain,
  reapplyRunsGuarded,
  revertRunsGuarded,
  runsFromTurn,
  setRunsDetached,
  type ChainEntry
} from './checkpoints'
import { activeRunForConversation } from './loop'
import { withRewindLock } from './rewindLock'

/**
 * Rewind a conversation to just before one of the user's earlier messages, the
 * engine behind the GUI's Rewind menu, edit-and-resend, and the TUI's `/rewind`.
 *
 * The target is named by its turn number (its position among the rewind points,
 * see `rewindableTurnIndices`) plus the text the client showed for it. A client's
 * view can lag the stored log (a run finished in another window), so the text is
 * checked and a mismatch refused rather than cutting at the wrong message.
 *
 * Code is put back through the conversation's checkpoint chain: every run from the
 * target turn on, newest first, each file only while it still holds what the agent
 * wrote (see revertRunsGuarded). Shell side effects were never snapshotted, so they
 * stay; both clients say so before a code rewind.
 *
 * The rewind is saved with a backup (Conversation.rewindBackup), so it can be undone
 * until the chat moves on.
 */

/** The ways a rewind is refused, as the clients show them. */
const ERR_RUNNING = 'Stop the running turn before rewinding.'
const ERR_MISSING = 'This conversation no longer exists.'
const ERR_STALE = 'That message is no longer in this conversation. Reopen the chat and try again.'
const ERR_BUSY = 'A rewind is already in progress for this conversation.'

interface Target {
  conv: Conversation
  /** Index of the target user message in `conv.messages`. */
  at: number
  /** Rewind points from the target on (the target included). */
  turns: number
  runs: ChainEntry[]
}

function locate(conversationId: string, turn: number, expectedText: string | undefined): Target | string {
  if (activeRunForConversation(conversationId)) return ERR_RUNNING
  // Peek: attachments stay as stored references, which is all a rewrite needs.
  const conv = peekConversation(conversationId)
  if (!conv) return ERR_MISSING
  const points = rewindableTurnIndices(conv.messages)
  const at = points[turn]
  if (at === undefined) return ERR_STALE
  if (expectedText !== undefined && turnText(conv.messages[at]) !== expectedText) return ERR_STALE
  return {
    conv,
    at,
    turns: points.length - turn,
    runs: runsFromTurn(conversationChain(conversationId), conv.messages, at)
  }
}

/** What rewinding to `turn` would do, without changing anything. */
export async function previewRewind(
  conversationId: string,
  turn: number,
  mode: RewindMode,
  expectedText?: string
): Promise<RewindPreviewResult> {
  const t = locate(conversationId, turn, expectedText)
  if (typeof t === 'string') return { ok: false, error: t }
  const code = rewindsCode(mode)
    ? await revertRunsGuarded(t.runs, { dryRun: true })
    : { restored: 0, conflicts: [], unavailable: 0 }
  return {
    ok: true,
    turns: rewindsConversation(mode) ? t.turns : 0,
    files: code.restored,
    conflicts: code.conflicts,
    unavailable: code.unavailable
  }
}

/** Rewind to just before turn `turn`. */
export function rewindConversation(
  conversationId: string,
  turn: number,
  mode: RewindMode,
  expectedText?: string
): Promise<RewindResult> {
  return withRewindLock<RewindResult>(conversationId, { ok: false, error: ERR_BUSY }, () =>
    rewindNow(conversationId, turn, mode, expectedText)
  )
}

async function rewindNow(
  conversationId: string,
  turn: number,
  mode: RewindMode,
  expectedText?: string
): Promise<RewindResult> {
  const t = locate(conversationId, turn, expectedText)
  if (typeof t === 'string') return { ok: false, error: t }
  const { conv, at, runs } = t
  const text = turnText(conv.messages[at])

  const code = rewindsCode(mode)
    ? await revertRunsGuarded(runs)
    : { restored: 0, conflicts: [], unavailable: 0, runs: [] }

  const cut = rewindsConversation(mode)
  const messages: ChatMessage[] = cut ? conv.messages.slice(0, at) : conv.messages
  // Runs whose turns leave the chat. Every run in the slice started at or after the
  // target, and a run never answers a message from before the one it started at.
  const detached = cut ? runs.filter((r) => !r.detached).map((r) => r.runId) : []
  if (detached.length) setRunsDetached(conversationId, detached, true)

  const backup: RewindBackup = {
    mode,
    at: Date.now(),
    ...(cut ? { messages: conv.messages } : {}),
    ...(cut && conv.compaction ? { compaction: conv.compaction } : {}),
    ...(cut && conv.lastError ? { lastError: conv.lastError } : {}),
    afterLength: messages.length,
    code: code.runs.filter((r) => r.files.length > 0),
    detached
  }
  writeRewind(conversationId, {
    messages,
    compaction: cut ? compactionAfterTruncate(conv.compaction, at) : (conv.compaction ?? null),
    // The failed turn the marker describes was cut along with the rest.
    lastError: cut ? null : (conv.lastError ?? null),
    backup
  })

  return {
    ok: true,
    // Hydrated, for the client to rebuild its transcript (images included).
    messages: getConversation(conversationId)?.messages ?? messages,
    text,
    restored: code.restored,
    conflicts: code.conflicts,
    unavailable: code.unavailable,
    undoable: true
  }
}

/** Whether the conversation's latest rewind can still be undone. */
export function canUndoRewind(conversationId: string): boolean {
  const conv = peekConversation(conversationId)
  return !!conv?.rewindBackup && conv.rewindBackup.afterLength === conv.messages.length
}

/**
 * Undo the latest rewind: bring back the messages it removed (with the compaction
 * state and failed-turn marker they had) and re-apply the files it put back, each
 * only while it still holds the content the rewind left there.
 */
export function undoRewind(conversationId: string): Promise<UndoRewindResult> {
  return withRewindLock<UndoRewindResult>(conversationId, { ok: false, error: ERR_BUSY }, () =>
    undoNow(conversationId)
  )
}

async function undoNow(conversationId: string): Promise<UndoRewindResult> {
  if (activeRunForConversation(conversationId)) return { ok: false, error: ERR_RUNNING }
  const conv = peekConversation(conversationId)
  if (!conv) return { ok: false, error: ERR_MISSING }
  const backup = conv.rewindBackup
  if (!backup || backup.afterLength !== conv.messages.length) {
    return { ok: false, error: 'There is no rewind to undo: the chat has moved on since.' }
  }
  const code = await reapplyRunsGuarded(backup.code)
  if (backup.detached.length) setRunsDetached(conversationId, backup.detached, false)
  const restoresLog = backup.messages !== undefined
  writeRewind(conversationId, {
    messages: backup.messages ?? conv.messages,
    compaction: restoresLog ? (backup.compaction ?? null) : (conv.compaction ?? null),
    lastError: restoresLog ? (backup.lastError ?? null) : (conv.lastError ?? null),
    backup: null
  })
  return {
    ok: true,
    messages: getConversation(conversationId)?.messages ?? backup.messages ?? conv.messages,
    reapplied: code.reapplied,
    conflicts: code.conflicts
  }
}
