import { createContext, useContext } from 'react'
import { imageDataUrl, type ImageAttachment } from '@shared/images'
import { fileNameOf, type GalleryArgs } from '@shared/gallery'
import type { MockupArgs, MockupVariant } from '@shared/mockup'

/**
 * The full-size image viewer. Any transcript row can open it (a show_images
 * gallery, a screenshot in a tool card); App owns the one viewer so it can count as
 * an open modal, which hides the native preview views that would otherwise paint
 * over it (see lib/overlays.ts).
 */

export interface ViewerImage {
  src: string
  label: string
  caption?: string
  /** The file the image came from, when there is one, for "Open file". */
  path?: string
}

export interface ImageViewerApi {
  open(images: ViewerImage[], index: number): void
}

export const ImageViewerContext = createContext<ImageViewerApi | null>(null)

/** The app's viewer, or null outside the provider (tests rendering a row alone). */
export function useImageViewer(): ImageViewerApi | null {
  return useContext(ImageViewerContext)
}

/** Move `delta` steps through `count` images, wrapping at both ends. */
export function stepIndex(index: number, delta: number, count: number): number {
  if (count <= 0) return 0
  return (((index + delta) % count) + count) % count
}

/**
 * Pair a show_images call's arguments with the images its result attached. The
 * tool attaches exactly one image per entry, in order, or none at all (it is
 * all-or-nothing), so a count mismatch means the result isn't the gallery's and
 * nothing is returned rather than labels landing on the wrong pictures.
 */
export function galleryViewerImages(gallery: GalleryArgs, images: ImageAttachment[] | undefined): ViewerImage[] {
  if (!images || images.length !== gallery.images.length) return []
  return gallery.images.map((g, i) => ({
    src: imageDataUrl(images[i]),
    label: g.label,
    ...(g.caption ? { caption: g.caption } : {}),
    path: g.path
  }))
}

/**
 * Pair a call's viewport variants with the screenshots it attached, one per variant
 * in order (render_mockup, or view_localhost with variants); a count mismatch
 * returns nothing, as for galleries. The images carry no path: they were never
 * files, only captures. `subject` names what was captured, for the caption.
 */
export function variantViewerImages(
  variants: MockupVariant[],
  images: ImageAttachment[] | undefined,
  subject: string
): ViewerImage[] {
  if (!images || images.length !== variants.length) return []
  return variants.map((v, i) => ({
    src: imageDataUrl(images[i]),
    label: v.label,
    caption: `${subject} at ${v.width}×${v.height}, ${v.colorScheme} color scheme.`
  }))
}

/** A render_mockup call's screenshots, captioned with the mockup's file name. */
export function mockupViewerImages(mockup: MockupArgs, images: ImageAttachment[] | undefined): ViewerImage[] {
  return variantViewerImages(mockup.variants, images, fileNameOf(mockup.file))
}
