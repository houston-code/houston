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

/** Largest image data URL the viewer may hand the main process to copy or save. */
const MAX_IMAGE_DATA_URL_CHARS = 32 * 1024 * 1024

/**
 * Parse an image `data:` URL from an untrusted boundary (IPC) into its type and
 * base64 payload, or null when it isn't a supported, base64-encoded image of a sane
 * size. Never throws.
 */
export function parseImageDataUrl(value: unknown): ImageAttachment | null {
  if (typeof value !== 'string' || value.length > MAX_IMAGE_DATA_URL_CHARS) return null
  const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value)
  if (!m || !isSupportedImageType(m[1])) return null
  return { mediaType: m[1], data: m[2] }
}

/** A safe file name for saving an image: the label's words, the type's extension. */
export function imageFileName(label: string, mediaType: string): string {
  const ext = mediaType === 'image/jpeg' ? 'jpg' : mediaType.replace(/^image\//, '')
  const base = label.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'image'
  return `${base}.${ext}`
}
