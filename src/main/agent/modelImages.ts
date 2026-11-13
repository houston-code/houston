import type { ChatMessage } from '@shared/agent'
import type { ImageAttachment } from '@shared/images'
import { mediaDigest } from '../mediaDigest'
import { imageSize } from './imageSize'

/**
 * The model's copy of each image, kept small. Screenshots and galleries are often
 * 2000 to 6000 pixels on a side; a provider bills (and most providers shrink
 * internally) by pixel count, and every image in the history is resent on each
 * later turn. So images go to the model scaled down to {@link MODEL_IMAGE_MAX_EDGE}
 * on their long side, while the conversation, the transcript, and the gallery keep
 * the full-size original.
 *
 * Scaling needs an image codec, which only the Electron shell has (nativeImage);
 * it is injected with {@link setImageDownscaler}, and where none is wired (the
 * standalone CLI, tests) images go to the model unchanged.
 */

/** Long-side cap for the model's copy: the size the major vision models work at. */
export const MODEL_IMAGE_MAX_EDGE = 1568

/**
 * Returns a smaller copy, or null to send the image as it is (already small, or
 * undecodable). It must return null for an image whose long side is already at most
 * `maxEdge`: such images are recognized from their header and never handed to it.
 */
export type ImageDownscaler = (img: ImageAttachment, maxEdge: number) => Promise<ImageAttachment | null>

/** Most base64 characters of model copies kept in the content cache. */
export const MODEL_IMAGE_CACHE_BYTES = 64 * 1024 * 1024

let downscaler: ImageDownscaler | null = null

/**
 * Model copies by original object: the run's message log hands the same attachment
 * objects to every step, so a step after the first finds each image here.
 */
let byObject = new WeakMap<ImageAttachment, Promise<ImageAttachment>>()

interface ContentEntry {
  /** The smaller copy, or null to send the original. */
  result: Promise<ImageAttachment | null>
  settled: boolean
  /** Base64 characters held once settled; a nominal amount for a null result. */
  bytes: number
}

/**
 * Model copies by image content (a sha256 of the base64 data, plus the media type),
 * least recently used first. Every run loads the conversation afresh, so the next
 * turn's attachments are new objects holding the same bytes; this lets them reuse
 * the copy made on an earlier turn instead of decoding and scaling every image
 * again, and keeps the bytes sent identical from turn to turn (which keeps the
 * provider's prompt cache valid).
 */
let byContent = new Map<string, ContentEntry>()
let contentBytes = 0

export function setImageDownscaler(fn: ImageDownscaler | null): void {
  downscaler = fn
  byObject = new WeakMap()
  byContent = new Map()
  contentBytes = 0
}

function evict(): void {
  for (const [key, entry] of byContent) {
    if (contentBytes <= MODEL_IMAGE_CACHE_BYTES) return
    if (!entry.settled) continue
    byContent.delete(key)
    contentBytes -= entry.bytes
  }
}

function contentCopy(img: ImageAttachment, scale: ImageDownscaler): Promise<ImageAttachment | null> {
  // The digest is the full content hash, so two images share an entry only when
  // their bytes and media type are the same.
  const key = `${mediaDigest(img)}:${img.mediaType}`
  const cached = byContent.get(key)
  if (cached) {
    byContent.delete(key)
    byContent.set(key, cached)
    return cached.result
  }
  const map = byContent
  const entry: ContentEntry = { result: Promise.resolve(null), settled: false, bytes: 0 }
  entry.result = new Promise<ImageAttachment | null>((resolve) => resolve(scale(img, MODEL_IMAGE_MAX_EDGE))).then(
    (small) => {
      entry.settled = true
      if (map.get(key) === entry) {
        entry.bytes = small ? small.data.length + small.mediaType.length : key.length
        contentBytes += entry.bytes
        evict()
      }
      return small
    },
    () => {
      // A failure is not remembered by content, so a later object holding these
      // bytes tries again; this object still falls back to the original.
      if (map.get(key) === entry) map.delete(key)
      return null
    }
  )
  map.set(key, entry)
  return entry.result
}

function modelCopy(img: ImageAttachment): Promise<ImageAttachment> {
  const scale = downscaler
  if (!scale) return Promise.resolve(img)
  let pending = byObject.get(img)
  if (!pending) {
    const size = imageSize(img.data)
    // Already within the cap: the scaler would return null, so skip decoding it.
    pending =
      size && Math.max(size.width, size.height) <= MODEL_IMAGE_MAX_EDGE
        ? Promise.resolve(img)
        : contentCopy(img, scale).then((small) => small ?? img)
    byObject.set(img, pending)
  }
  return pending
}

/**
 * The messages to send, with every image replaced by its model copy. Messages
 * without images are passed through as the same objects; nothing in `messages` is
 * mutated.
 */
export async function withModelImages(messages: ChatMessage[]): Promise<ChatMessage[]> {
  if (!downscaler || !messages.some((m) => m.images?.length)) return messages
  return Promise.all(
    messages.map(async (m) => {
      if (!m.images?.length) return m
      const images = await Promise.all(m.images.map(modelCopy))
      return images.every((img, i) => img === m.images![i]) ? m : { ...m, images }
    })
  )
}
