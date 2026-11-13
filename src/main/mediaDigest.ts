import { createHash } from 'node:crypto'

/**
 * The sha256 hex digest of an attachment's base64 `data`: the content address its
 * bytes are stored under beside a conversation (see conversationMedia.ts) and part
 * of the key the model's downscaled copy is cached under (see agent/modelImages.ts).
 *
 * Digests are remembered per attachment object, so an image is hashed at most once
 * however many saves and turns hand the same object around. Loading a conversation
 * records the digest each attachment was stored under, so a freshly loaded image is
 * not hashed again just to be looked up.
 */
const digests = new WeakMap<object, string>()

export function mediaDigest(att: { data: string }): string {
  let digest = digests.get(att)
  if (!digest) {
    digest = createHash('sha256').update(att.data).digest('hex')
    digests.set(att, digest)
  }
  return digest
}

/** Record the digest an attachment's `data` is already known to have (read from its content address). */
export function rememberMediaDigest(att: object, digest: string): void {
  digests.set(att, digest)
}
