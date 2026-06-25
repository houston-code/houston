import { randomUUID } from 'node:crypto'
import type { AgentEvent, AgentRunRequest, ChatMessage } from '@shared/agent'
import { combineQueued, type QueuedInputMeta } from '@shared/queue'
import { startRun } from './loop'
import { takeQueue } from './queue'
import { getConversation, setMessages, updateConversationMeta } from '../conversations'

/** How the run orchestrator talks back to the renderer (provided by the IPC layer). */
export interface DrainIO {
  /** Stream one agent event to the renderer (persisting usage totals along the way). */
  emit: (conversationId: string, e: AgentEvent) => void
  /** Push a conversation's updated queue to the renderer (after an auto-flush). */
  emitQueueChanged: (conversationId: string, items: QueuedInputMeta[]) => void
}

/**
 * Run a turn and, when it finishes *naturally* (not aborted, not errored), flush
 * any messages queued during it as the next combined turn. The queue is held on
 * cancel/error so the user can retry or dispatch it deliberately. Fire-and-forget:
 * progress is streamed through `io`, so callers don't await this.
 */
export async function runAndDrain(
  io: DrainIO,
  conversationId: string,
  runReq: AgentRunRequest
): Promise<void> {
  let terminal: 'natural' | 'aborted' | 'error' = 'natural'
  const send = (e: AgentEvent): void => {
    if (e.type === 'error') terminal = 'error'
    else if (e.type === 'done') terminal = e.stopReason === 'aborted' ? 'aborted' : 'natural'
    io.emit(conversationId, e)
  }
  // Tag the run with its conversation so the loop enforces one live run per
  // conversation (a second would interleave its setMessages writes and corrupt
  // the log). The slot is freed when this run ends, before any queue drain below.
  await startRun({ ...runReq, conversationId }, send, (msgs) => setMessages(conversationId, msgs))
  if (terminal === 'natural') drainQueue(io, conversationId)
}

/** Dispatch a conversation's queued messages as one combined follow-up turn. */
export function drainQueue(io: DrainIO, conversationId: string): void {
  const taken = takeQueue(conversationId)
  if (!taken) return
  const { text, images } = combineQueued(taken.items)
  if (!text && !images) return
  const conv = getConversation(conversationId)
  if (!conv) return

  const runId = randomUUID()
  const userMessage: ChatMessage = {
    role: 'user',
    content: text,
    ...(images?.length ? { images } : {})
  }
  const messages = [...conv.messages, userMessage]
  setMessages(conv.id, messages)
  updateConversationMeta(conv.id, { providerId: taken.providerId, model: taken.model })

  // Tell a renderer viewing this conversation to render the user bubble and adopt
  // the run; the queue is now empty, so refresh its bar too.
  io.emit(conversationId, {
    runId,
    type: 'turn_start',
    conversationId,
    userText: text,
    ...(images?.length ? { images } : {})
  })
  io.emitQueueChanged(conversationId, [])

  void runAndDrain(io, conversationId, {
    runId,
    workspace: conv.workspace,
    providerId: taken.providerId,
    model: taken.model,
    approvalPolicy: taken.approvalPolicy,
    messages
  })
}
