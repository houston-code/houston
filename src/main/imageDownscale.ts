import { nativeImage } from 'electron'
import type { ImageAttachment } from '@shared/images'
import { setImageDownscaler } from './agent/modelImages'

/**
 * Scale an image so its long side is at most `maxEdge`, with Electron's built-in
 * codec. Returns null when it is already small enough or can't be decoded, so the
 * original goes to the model. JPEG stays JPEG; everything else comes back as PNG.
 */
export async function downscaleWithNativeImage(img: ImageAttachment, maxEdge: number): Promise<ImageAttachment | null> {
  const image = nativeImage.createFromBuffer(Buffer.from(img.data, 'base64'))
  if (image.isEmpty()) return null
  const { width, height } = image.getSize()
  const longSide = Math.max(width, height)
  if (longSide <= maxEdge) return null
  const scale = maxEdge / longSide
  const resized = image.resize({
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    quality: 'good'
  })
  const jpeg = img.mediaType === 'image/jpeg'
  const bytes = jpeg ? resized.toJPEG(85) : resized.toPNG()
  return { mediaType: jpeg ? 'image/jpeg' : 'image/png', data: bytes.toString('base64') }
}

/** Give the agent the Electron image scaler for the model's copies. Call once at startup. */
export function wireImageDownscale(): void {
  setImageDownscaler(downscaleWithNativeImage)
}
