import { randomUUID } from 'node:crypto'
import type { ApprovalPolicy } from '@shared/types'
import {
  toQueuedMeta,
  type QueueAddRequest,
  type QueuedInput,
  type QueuedInputMeta
} from '@shared/queue'
import { sanitizeAttachments } from '@shared/images'

/** The send settings to use when a conversation's queue is flushed as the next turn. */
interface QueueState {
  items: QueuedInput[]
  providerId: string
  model: string
  approvalPolicy: ApprovalPolicy
}

/**
 * Per-conversation buffer of messages typed while a run was in progress. Held in
 * the main process (not the renderer) so a queued follow-up still fires when its
 * conversation's run finishes — even if the user has navigated to another chat.
 * In-memory only: like the runs themselves, the queue is dropped if the app quits.
 */
const queues = new Map<string, QueueState>()

/** Append a message to a conversation's queue; returns the updated display list. */
export function addToQueue(req: QueueAddRequest): QueuedInputMeta[] {
  const images = sanitizeAttachments(req.images)
  const item: QueuedInput = {
    id: randomUUID(),
    text: req.userText,
    ...(images.length ? { images } : {})
  }
  const existing = queues.get(req.conversationId)
  // The newest message's send settings win when the combined turn is dispatched.
  const next: QueueState = {
    items: [...(existing?.items ?? []), item],
    providerId: req.providerId,
    model: req.model,
    approvalPolicy: req.approvalPolicy
  }
  queues.set(req.conversationId, next)
  return toQueuedMeta(next.items)
}

/** Drop one queued message by id; returns the updated display list. */
export function removeFromQueue(conversationId: string, id: string): QueuedInputMeta[] {
  const state = queues.get(conversationId)
  if (!state) return []
  const items = state.items.filter((q) => q.id !== id)
  if (items.length) queues.set(conversationId, { ...state, items })
  else queues.delete(conversationId)
  return toQueuedMeta(items)
}

/** Discard a conversation's entire queue; returns the (now empty) display list. */
export function clearQueue(conversationId: string): QueuedInputMeta[] {
  queues.delete(conversationId)
  return []
}

/** The display list for a conversation (empty when nothing is queued). */
export function listQueue(conversationId: string): QueuedInputMeta[] {
  return toQueuedMeta(queues.get(conversationId)?.items ?? [])
}

/**
 * Remove and return a conversation's whole queue for dispatch as the next turn,
 * or null when nothing is queued. After this the conversation's queue is empty.
 */
export function takeQueue(conversationId: string): QueueState | null {
  const state = queues.get(conversationId)
  if (!state || state.items.length === 0) return null
  queues.delete(conversationId)
  return state
}
