/**
 * Image attachments a user can add to a message (drag-drop or paste). Stored as
 * base64 (no data: prefix) plus the media type, and sent to the provider as an
 * image content block. Helpers are pure so they can be validated/tested on both
 * sides of the IPC boundary.
 */

export interface ImageAttachment {
  mediaType: string
  /** Base64-encoded image bytes (no `data:` URI prefix). */
  data: string
}

export const SUPPORTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

/** Max attachments per message, and max bytes per image (≈ base64 length × 3/4). */
export const MAX_ATTACHMENTS = 8
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

export function isSupportedImageType(t: string): boolean {
  return SUPPORTED_IMAGE_TYPES.includes(t)
}

/** True if a base64 payload is over the per-image size cap (≈ length × 3/4 bytes). */
export function exceedsImageSizeLimit(base64: string): boolean {
  return base64.length > Math.ceil(MAX_IMAGE_BYTES * 1.4)
}

/** Build a `data:` URL (used by the OpenAI adapter and for renderer previews). */
export function imageDataUrl(a: ImageAttachment): string {
  return `data:${a.mediaType};base64,${a.data}`
}

/**
 * Validate/clamp attachments arriving from an untrusted boundary (IPC). Drops
 * anything with an unsupported type, missing data, or oversized payload, and caps
 * the count. Never throws.
 */
export function sanitizeAttachments(value: unknown): ImageAttachment[] {
  if (!Array.isArray(value)) return []
  const out: ImageAttachment[] = []
  for (const v of value) {
    if (out.length >= MAX_ATTACHMENTS) break
    if (typeof v !== 'object' || v === null) continue
    const { mediaType, data } = v as Record<string, unknown>
    if (typeof mediaType !== 'string' || !isSupportedImageType(mediaType)) continue
    if (typeof data !== 'string' || data.length === 0) continue
    if (exceedsImageSizeLimit(data)) continue
    out.push({ mediaType, data })
  }
  return out
}
