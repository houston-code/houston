import type { ApprovalPolicy } from './types'
import { MAX_ATTACHMENTS, type ImageAttachment } from './images'
import { invocationText, type PromptInvocation } from './promptInvocation'

/** A message the user composed while a run was in progress, awaiting the next turn. */
export interface QueuedInput {
  id: string
  text: string
  images?: ImageAttachment[]
  /** Set when `text` is a first-party prompt (a ship button pressed mid-run). */
  invokedAs?: PromptInvocation
}

/** Display-only view of a queued message sent to the renderer (no image payloads). */
export interface QueuedInputMeta {
  id: string
  text: string
  imageCount: number
}

/** What the renderer asks the main process to queue while a run is in progress. */
export interface QueueAddRequest {
  conversationId: string
  userText: string
  images?: ImageAttachment[]
  invokedAs?: PromptInvocation
  providerId: string
  model: string
  approvalPolicy: ApprovalPolicy
}

/**
 * Strip image payloads down to a count for the renderer's queue bar. A queued
 * first-party prompt is listed by what the user did ("Create PR"), not its text.
 */
export function toQueuedMeta(items: QueuedInput[]): QueuedInputMeta[] {
  return items.map((q) => ({
    id: q.id,
    text: q.invokedAs ? invocationText(q.invokedAs) : q.text,
    imageCount: q.images?.length ?? 0
  }))
}

/**
 * Merge several queued messages into the single follow-up turn that gets sent
 * once the run ends. Text blocks are joined with a blank line between them;
 * images are concatenated and capped at the same limit the composer enforces.
 * A lone queued first-party prompt keeps its `invokedAs`; once it's merged with
 * other text the turn is no longer just that action, so it shows as written.
 */
export function combineQueued(inputs: QueuedInput[]): {
  text: string
  images?: ImageAttachment[]
  invokedAs?: PromptInvocation
} {
  const text = inputs
    .map((q) => q.text.trim())
    .filter(Boolean)
    .join('\n\n')
  const images = inputs.flatMap((q) => q.images ?? []).slice(0, MAX_ATTACHMENTS)
  const invokedAs = inputs.length === 1 ? inputs[0].invokedAs : undefined
  return { text, images: images.length ? images : undefined, ...(invokedAs ? { invokedAs } : {}) }
}
