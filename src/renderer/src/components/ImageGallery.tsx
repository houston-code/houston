import { useImageViewer, type ViewerImage } from '../lib/imageViewer'

/**
 * A show_images or render_mockup result: an optional title and source badge, the
 * image count, and a grid of labelled tiles. Clicking a tile opens the full-size
 * viewer at that image, stepping through the rest of the set from there.
 */
export function ImageGallery({
  title,
  badge,
  images
}: {
  title?: string
  /** Where the images came from, e.g. "Mockup from code", set by the tool, never the model. */
  badge?: string
  images: ViewerImage[]
}): JSX.Element {
  const viewer = useImageViewer()
  const count = `${images.length} image${images.length === 1 ? '' : 's'}`
  return (
    <section className="image-gallery" aria-label={title ?? 'Images'}>
      <div className="image-gallery__bar">
        {title && <span className="image-gallery__title">{title}</span>}
        <span className="image-gallery__count">{count}</span>
        {badge && <span className="image-gallery__badge">{badge}</span>}
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
