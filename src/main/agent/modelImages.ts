import type { ChatMessage } from '@shared/agent'
import type { ImageAttachment } from '@shared/images'

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

/** Returns a smaller copy, or null to send the image as it is (already small, or undecodable). */
export type ImageDownscaler = (img: ImageAttachment, maxEdge: number) => Promise<ImageAttachment | null>

let downscaler: ImageDownscaler | null = null

export function setImageDownscaler(fn: ImageDownscaler | null): void {
  downscaler = fn
}

/**
 * Model copies by original. The run's message log hands the same attachment
 * objects to every turn, so each image is decoded and scaled once per run, and the
 * bytes stay identical from turn to turn (which keeps the provider's prompt cache
 * valid).
 */
const cache = new WeakMap<ImageAttachment, Promise<ImageAttachment>>()

function modelCopy(img: ImageAttachment): Promise<ImageAttachment> {
  const scale = downscaler
  if (!scale) return Promise.resolve(img)
  let pending = cache.get(img)
  if (!pending) {
    pending = scale(img, MODEL_IMAGE_MAX_EDGE).then(
      (small) => small ?? img,
      () => img
    )
    cache.set(img, pending)
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
