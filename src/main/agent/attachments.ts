import { isSupportedImageType } from '@shared/images'

/**
 * Detect when a file the agent reads is a viewable binary (image or PDF) rather
 * than text, so read_file can hand it to the model as an attachment instead of
 * returning garbled bytes. Detection is by extension (reliable and cheap).
 */

const EXT_TO_IMAGE_TYPE: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp'
}

/** Max bytes for an attached PDF (Anthropic accepts more, but keep it bounded). */
export const MAX_PDF_BYTES = 10 * 1024 * 1024
/** Max bytes for an attached image (matches the input-image cap). */
export const MAX_ATTACH_IMAGE_BYTES = 5 * 1024 * 1024

function ext(path: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(path)
  return m ? m[1].toLowerCase() : ''
}

/** The image media type for a path's extension, or null if it isn't a supported image. */
export function imageMediaTypeForPath(path: string): string | null {
  const t = EXT_TO_IMAGE_TYPE[ext(path)]
  return t && isSupportedImageType(t) ? t : null
}

export function isPdfPath(path: string): boolean {
  return ext(path) === 'pdf'
}

/** Human-readable byte size, e.g. "12.3 KB" / "1.4 MB". */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
