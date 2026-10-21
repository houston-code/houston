/**
 * The `show_images` gallery: the agent presents image files it produced (UI
 * screenshots, mockup renders, charts) to the user as a captioned gallery. The main
 * process validates the arguments and attaches the images to the tool result; the
 * renderer draws them from the same arguments plus those images. Pure helpers live
 * here so both processes share one definition.
 */

export const SHOW_IMAGES_NAME = 'show_images'

/** Most images one call may show. */
export const MAX_GALLERY_IMAGES = 12
export const MAX_GALLERY_TITLE = 80
export const MAX_GALLERY_LABEL = 80
export const MAX_GALLERY_CAPTION = 300

export interface GalleryImage {
  /** The file, as the agent named it (relative to the project, or absolute inside it). */
  path: string
  /** Short name shown under the tile; defaults to the file name. */
  label: string
  /** Optional sentence shown in the full-size viewer. */
  caption?: string
  /** Another image to compare this one against (e.g. the "before"), shown side by side in the viewer. */
  compareWith?: string
}

export interface GalleryArgs {
  title?: string
  images: GalleryImage[]
}

/**
 * Every file a gallery reads, in the order the tool attaches them: each entry's
 * image, then each `compareWith` image in entry order. The renderer pairs the
 * attached images back up by the same order.
 */
export function galleryFiles(gallery: GalleryArgs): string[] {
  return [
    ...gallery.images.map((g) => g.path),
    ...gallery.images.flatMap((g) => (g.compareWith ? [g.compareWith] : []))
  ]
}

/** The last path segment, for a default label. */
export function fileNameOf(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function optionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`${field} must be a string.`)
  const text = value.replace(/\s+/g, ' ').trim()
  if (!text) return undefined
  if (text.length > max) throw new Error(`${field} must be at most ${max} characters.`)
  return text
}

/**
 * Validate and normalize raw `show_images` arguments. Throws a descriptive error on
 * malformed input so the agent gets a useful tool result and can correct itself.
 */
export function parseGalleryArgs(args: Record<string, unknown>): GalleryArgs {
  const title = optionalText(args.title, 'title', MAX_GALLERY_TITLE)
  const raw = args.images
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('images must be a non-empty array.')
  if (raw.length > MAX_GALLERY_IMAGES) {
    throw new Error(`images allows at most ${MAX_GALLERY_IMAGES} entries; split them across calls.`)
  }
  const images = raw.map((item, i): GalleryImage => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`images[${i}] must be an object with a "path".`)
    }
    const o = item as Record<string, unknown>
    if (typeof o.path !== 'string' || !o.path.trim()) throw new Error(`images[${i}].path must be a non-empty string.`)
    const path = o.path.trim()
    const label = optionalText(o.label, `images[${i}].label`, MAX_GALLERY_LABEL) ?? fileNameOf(path)
    const caption = optionalText(o.caption, `images[${i}].caption`, MAX_GALLERY_CAPTION)
    let compareWith: string | undefined
    if (o.compareWith !== undefined && o.compareWith !== null) {
      if (typeof o.compareWith !== 'string' || !o.compareWith.trim()) {
        throw new Error(`images[${i}].compareWith must be a non-empty path.`)
      }
      compareWith = o.compareWith.trim()
    }
    return { path, label, ...(caption ? { caption } : {}), ...(compareWith ? { compareWith } : {}) }
  })
  const gallery = { ...(title ? { title } : {}), images }
  if (galleryFiles(gallery).length > MAX_GALLERY_IMAGES) {
    throw new Error(`a gallery shows at most ${MAX_GALLERY_IMAGES} images, counting compareWith images; split them across calls.`)
  }
  return gallery
}

/** Best-effort parse for display code that must not throw. Returns null on bad input. */
export function parseGalleryArgsSafe(args: Record<string, unknown> | undefined): GalleryArgs | null {
  if (!args) return null
  try {
    return parseGalleryArgs(args)
  } catch {
    return null
  }
}

/** Image formats the gallery accepts, identified by their leading bytes. */
export type GalleryImageType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

/**
 * The image type a file's leading bytes declare, or null when they aren't PNG, JPEG,
 * GIF, or WebP. Sniffing (rather than trusting the extension) is what keeps a
 * renamed key or `.env` file from ever being attached as an "image".
 */
export function sniffImageType(head: Uint8Array): GalleryImageType | null {
  const at = (i: number): number => head[i] ?? -1
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47 && at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a) {
    return 'image/png'
  }
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg'
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38 && (at(4) === 0x37 || at(4) === 0x39) && at(5) === 0x61) {
    return 'image/gif'
  }
  if (
    at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 &&
    at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50
  ) {
    return 'image/webp'
  }
  return null
}
