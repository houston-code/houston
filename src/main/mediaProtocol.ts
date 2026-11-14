import { session } from 'electron'
import { MEDIA_SCHEME } from '@shared/images'
import { readStoredImage } from './conversations'

/**
 * Serves a saved chat's stored images to the app window at
 * `houston-media://<conversation id>/<sha256>.<ext>`, so the window shows them from
 * their files instead of holding every one as base64 (see viewMedia).
 *
 * Registered on the default session only, which is the app's own window: the
 * preview, capture and mockup windows run on their own partitions and cannot reach
 * it, and HTML visual frames are held to `img-src data: blob:` by their CSP. Only
 * image files are served, named by a content digest inside a store-issued chat id,
 * so a URL can never reach outside a chat's media folder.
 */
export function serveStoredMedia(url: string): { status: number; body: Uint8Array | null; headers: Record<string, string> } {
  const image = readStoredImage(url)
  if (!image) return { status: 404, body: null, headers: { 'content-type': 'text/plain' } }
  return {
    status: 200,
    body: new Uint8Array(image.bytes),
    headers: {
      'content-type': image.mediaType,
      // Content-addressed: the bytes under a name never change.
      'cache-control': 'private, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff'
    }
  }
}

/** Call once the app is ready (it uses the default session). */
export function wireMediaProtocol(): void {
  session.defaultSession.protocol.handle(MEDIA_SCHEME, (req) => {
    const served = serveStoredMedia(req.url)
    return new Response(served.body as BodyInit | null, { status: served.status, headers: served.headers })
  })
}
