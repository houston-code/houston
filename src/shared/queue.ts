import type { ApprovalPolicy } from './types'
import { MAX_ATTACHMENTS, type ImageAttachment } from './images'

/** A message the user composed while a run was in progress, awaiting the next turn. */
export interface QueuedInput {
  id: string
  text: string
  images?: ImageAttachment[]
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
  providerId: string
  model: string
  approvalPolicy: ApprovalPolicy
}

/** Strip image payloads down to a count for the renderer's queue bar. */
export function toQueuedMeta(items: QueuedInput[]): QueuedInputMeta[] {
  return items.map((q) => ({ id: q.id, text: q.text, imageCount: q.images?.length ?? 0 }))
}

/**
 * Merge several queued messages into the single follow-up turn that gets sent
 * once the run ends. Text blocks are joined with a blank line between them;
 * images are concatenated and capped at the same limit the composer enforces.
 */
export function combineQueued(inputs: QueuedInput[]): {
  text: string
  images?: ImageAttachment[]
} {
  const text = inputs
    .map((q) => q.text.trim())
    .filter(Boolean)
    .join('\n\n')
  const images = inputs.flatMap((q) => q.images ?? []).slice(0, MAX_ATTACHMENTS)
  return { text, images: images.length ? images : undefined }
}
