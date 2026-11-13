import { imageDataUrl, type ImageAttachment } from '@shared/images'

/**
 * The `data:` URL for an attachment, built once per attachment object.
 *
 * Building it in render made a fresh multi-megabyte string for every image on every
 * render of the row (every streamed token, while the transcript re-renders), which
 * React then compared against the previous one character by character before deciding
 * the `src` had not changed. Attachment objects are immutable and keep their identity
 * across renders, so the same string instance comes back and that comparison is a
 * pointer check. Held weakly: the URL goes when the attachment does.
 */
const urls = new WeakMap<ImageAttachment, string>()

export function cachedImageDataUrl(a: ImageAttachment): string {
  let url = urls.get(a)
  if (url === undefined) {
    url = imageDataUrl(a)
    urls.set(a, url)
  }
  return url
}
