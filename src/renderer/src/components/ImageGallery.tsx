import type { GalleryArgs } from '@shared/gallery'
import { useImageViewer, type ViewerImage } from '../lib/imageViewer'

/**
 * A show_images result: an optional title, the image count, and a grid of labelled
 * tiles. Clicking a tile opens the full-size viewer at that image, stepping through
 * the rest of the set from there.
 */
export function ImageGallery({ gallery, images }: { gallery: GalleryArgs; images: ViewerImage[] }): JSX.Element {
  const viewer = useImageViewer()
  const count = `${images.length} image${images.length === 1 ? '' : 's'}`
  return (
    <section className="image-gallery" aria-label={gallery.title ?? 'Images'}>
      <div className="image-gallery__bar">
        {gallery.title && <span className="image-gallery__title">{gallery.title}</span>}
        <span className="image-gallery__count">{count}</span>
      </div>
      <ul className={`image-gallery__grid${images.length === 1 ? ' image-gallery__grid--single' : ''}`}>
        {images.map((img, i) => (
          <li key={i} className="image-gallery__tile">
            <button
              type="button"
              className="image-gallery__open"
              onClick={() => viewer?.open(images, i)}
              disabled={!viewer}
              aria-label={`Open ${img.label} full size`}
            >
              <img className="image-gallery__image" src={img.src} alt={img.caption ?? img.label} />
            </button>
            <span className="image-gallery__label" title={img.path}>
              {img.label}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
