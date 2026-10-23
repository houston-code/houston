import { randomUUID } from 'node:crypto'
import { isApprovalPolicy } from '@shared/types'
import { isReasoningEffort, type ConversationSettingsPatch } from '@shared/agent'
import {
  toQueuedMeta,
  type QueueAddRequest,
  type QueuedInput,
  type QueuedInputMeta,
  type StoredQueue
} from '@shared/queue'
import { sanitizeAttachments } from '@shared/images'
import { sanitizeInvocation } from '@shared/promptInvocation'
import { getQueuedInput, setQueuedInput } from '../conversations'

/**
 * Per-conversation buffer of messages typed while a run was in progress. Held in
 * the main process (not the renderer) so a queued follow-up still fires when its
 * conversation's run finishes, even if the user has navigated to another chat.
 *
 * Written through to the conversation file on every change: a message the user
 * sent must outlive a quit, a crash, or a restart to install an update, so the
 * Map is only a cache of what is on disk. Steers live here too (flagged `steer`)
 * until the run reads them, which is what makes a steer as durable as a queued
 * message (see QueuedInput.steer).
 */
const queues = new Map<string, StoredQueue | null>()

/** Rebuild a stored queue from disk, dropping anything malformed (a hand-edited file). */
function sanitizeStored(raw: StoredQueue | null): StoredQueue | null {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) return null
  if (typeof raw.providerId !== 'string' || typeof raw.model !== 'string') return null
  const items: QueuedInput[] = []
  for (const q of raw.items) {
    if (!q || typeof q !== 'object' || typeof q.id !== 'string' || typeof q.text !== 'string') continue
    const images = sanitizeAttachments(q.images)
    const invokedAs = sanitizeInvocation(q.invokedAs)
    // No `steer`: runs live in memory, so whatever run a stored steer was waiting on
    // is gone by the time the queue is read back. It is an ordinary follow-up now.
    items.push({
      id: q.id,
      text: q.text,
      ...(images.length ? { images } : {}),
      ...(invokedAs ? { invokedAs } : {})
    })
  }
  if (!items.length) return null
  return {
    items,
    providerId: raw.providerId,
    model: raw.model,
    approvalPolicy: isApprovalPolicy(raw.approvalPolicy) ? raw.approvalPolicy : 'plan',
    ...(isReasoningEffort(raw.reasoningEffort) ? { reasoningEffort: raw.reasoningEffort } : {})
  }
}

function load(conversationId: string): StoredQueue | null {
  if (queues.has(conversationId)) return queues.get(conversationId) ?? null
  const state = sanitizeStored(getQueuedInput(conversationId))
  queues.set(conversationId, state)
  return state
}

function save(conversationId: string, state: StoredQueue | null): void {
  const next = state && state.items.length ? state : null
  queues.set(conversationId, next)
  setQueuedInput(conversationId, next)
}

/**
 * Append a message to a conversation's queue; returns the updated display list.
 * `steer` records it as a steer the live run holds under `id` (see QueuedInput.steer).
 */
export function addToQueue(
  req: QueueAddRequest,
  opts: { id?: string; steer?: boolean } = {}
): QueuedInputMeta[] {
  const images = sanitizeAttachments(req.images)
  const invokedAs = sanitizeInvocation(req.invokedAs)
  const item: QueuedInput = {
    id: opts.id ?? randomUUID(),
    text: req.userText,
    ...(images.length ? { images } : {}),
    ...(invokedAs ? { invokedAs } : {}),
    ...(opts.steer ? { steer: true as const } : {})
  }
  const existing = load(req.conversationId)
  // The newest message's send settings win when the combined turn is dispatched.
  const next: StoredQueue = {
    items: [...(existing?.items ?? []), item],
    providerId: req.providerId,
    model: req.model,
    // Validated here like agentStart: the drained turn runs under these, and an
    // unknown policy fails open downstream, so coerce it to the most restrictive.
    approvalPolicy: isApprovalPolicy(req.approvalPolicy) ? req.approvalPolicy : 'plan',
    ...(isReasoningEffort(req.reasoningEffort) ? { reasoningEffort: req.reasoningEffort } : {})
  }
  save(req.conversationId, next)
  return toQueuedMeta(next.items)
}

/**
 * Carry a change to the chat's own settings over to what is queued for it. The queue
 * keeps the settings the messages were sent under, and its turn runs (and is recorded
 * on the chat) under them, so without this a change made while the current run went on
 * was undone by the follow-up: tightening the chat to plan mid-run still sent the queued
 * message in full-auto, and the chat was set back to full-auto. Validated like
 * {@link addToQueue}: a field off its list, or a model without its provider, is ignored.
 */
export function retargetQueue(conversationId: string, patch: ConversationSettingsPatch): void {
  const state = load(conversationId)
  if (!state || typeof patch !== 'object' || patch === null) return
  const { providerId, model, reasoningEffort, approvalPolicy } = patch as Record<string, unknown>
  const next: StoredQueue = { ...state }
  // Provider and model move together: a model id only means something under its provider.
  if (typeof providerId === 'string' && providerId && typeof model === 'string' && model) {
    next.providerId = providerId
    next.model = model
  }
  if (isReasoningEffort(reasoningEffort)) next.reasoningEffort = reasoningEffort
  if (isApprovalPolicy(approvalPolicy)) next.approvalPolicy = approvalPolicy
  save(conversationId, next)
}

/** Drop one queued message by id; returns the updated display list. */
export function removeFromQueue(conversationId: string, id: string): QueuedInputMeta[] {
  const state = load(conversationId)
  if (!state) return []
  const items = state.items.filter((q) => q.id !== id)
  if (items.length !== state.items.length) save(conversationId, { ...state, items })
  return toQueuedMeta(items)
}

/** Discard a conversation's entire queue; returns the (now empty) display list. */
export function clearQueue(conversationId: string): QueuedInputMeta[] {
  if (load(conversationId)) save(conversationId, null)
  return []
}

/** Forget a deleted conversation's queue (its file, and the queue with it, are gone). */
export function forgetQueue(conversationId: string): void {
  queues.delete(conversationId)
}

/** The display list for a conversation (empty when nothing is queued). */
export function listQueue(conversationId: string): QueuedInputMeta[] {
  return toQueuedMeta(load(conversationId)?.items ?? [])
}

/** Ids of the queue's entries that are steers still waiting on the live run. */
export function queuedSteerIds(conversationId: string): string[] {
  return (load(conversationId)?.items ?? []).filter((q) => q.steer).map((q) => q.id)
}

/**
 * The run these steers were waiting on has ended without reading them: turn them
 * into ordinary follow-ups. Returns the display list when anything changed, else null.
 */
export function settleSteers(conversationId: string): QueuedInputMeta[] | null {
  const state = load(conversationId)
  if (!state?.items.some((q) => q.steer)) return null
  const items = state.items.map(({ steer: _steer, ...q }) => q)
  save(conversationId, { ...state, items })
  return toQueuedMeta(items)
}

/**
 * Remove and return a conversation's whole queue for dispatch as the next turn,
 * or null when nothing is queued. After this the conversation's queue is empty.
 */
export function takeQueue(conversationId: string): StoredQueue | null {
  const state = load(conversationId)
  if (!state || state.items.length === 0) return null
  save(conversationId, null)
  return state
}

/** Test seam: drop the in-memory cache so the next read comes from disk (a restart). */
export function resetQueueCache(): void {
  queues.clear()
}
