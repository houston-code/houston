import { isSupportedImageType } from '@shared/images'

/**
 * Detect when a file the agent reads is not text.
 *
 * Two layers, because extension alone answers a different question than the one
 * read_file needs:
 *   - EXTENSION tells us a file is a *viewable* binary — an image or PDF worth
 *     attaching for the model to look at. That has to be extension-based: the
 *     decision is "which media type do I declare", and the answer lives in the name.
 *   - CONTENT tells us a file is binary at all. Everything not caught by the
 *     extension layer used to be decoded as UTF-8 regardless, so a .db, .so, .zip,
 *     or a .png someone saved as .txt came back as thousands of tokens of mojibake
 *     that the model then tried to reason about. {@link looksBinary} sniffs the
 *     bytes so those get an honest "this is binary" instead.
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

/** How much of a file's head {@link looksBinary} sniffs. Matches git's heuristic. */
export const BINARY_SNIFF_BYTES = 8000

/**
 * Whether a buffer looks like binary rather than text, by the same rule git uses:
 * a NUL byte anywhere in the first {@link BINARY_SNIFF_BYTES}.
 *
 * NUL is the discriminator because it cannot appear in valid UTF-8 text but is
 * pervasive in compiled objects, archives, images, and databases. It is a
 * heuristic, deliberately: the alternative (validating UTF-8 across the whole file)
 * costs more and still can't separate "text in an encoding we don't speak" from
 * "binary". Two known, accepted consequences of matching git here:
 *   - UTF-16/UTF-32 text reads as binary, since its ASCII range is NUL-padded.
 *   - A binary whose first 8000 bytes happen to be NUL-free is treated as text.
 */
export function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)
}

/** Human-readable byte size, e.g. "12.3 KB" / "1.4 MB". */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
