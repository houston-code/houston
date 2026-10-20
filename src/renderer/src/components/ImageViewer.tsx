import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useFocusTrap } from '../lib/useFocusTrap'
import { stepIndex, type ViewerImage } from '../lib/imageViewer'

/**
 * Full-window viewer for one set of images: the current image as large as the
 * window allows, its label and caption, and arrows (or ←/→) to step through the
 * set. Esc, the ✕ button, or a click on the backdrop closes it, and focus returns to
 * whatever opened it.
 */
export function ImageViewer({
  images,
  initialIndex,
  onClose,
  onOpenFile
}: {
  images: ViewerImage[]
  initialIndex: number
  onClose: () => void
  /** Open the image's file in its default app; resolves to an error message on failure. */
  onOpenFile?: (path: string) => Promise<string | null>
}): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  useFocusTrap(ref, onClose)
  const [index, setIndex] = useState(() => stepIndex(initialIndex, 0, images.length))
  const [openError, setOpenError] = useState<string | null>(null)
  const image = images[index]
  if (!image) return null
  const many = images.length > 1

  const go = (delta: number): void => {
    setOpenError(null)
    setIndex((i) => stepIndex(i, delta, images.length))
  }
  const onKeyDown = (e: ReactKeyboardEvent): void => {
    if (!many) return
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      go(-1)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      go(1)
    }
  }
  const openFile = (): void => {
    if (!image.path || !onOpenFile) return
    void onOpenFile(image.path).then(setOpenError)
  }

  return (
    <div className="image-viewer" onClick={onClose}>
      <div
        className="image-viewer__dialog"
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={image.label}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="image-viewer__bar">
          <span className="image-viewer__label">{image.label}</span>
          {many && (
            <span className="image-viewer__count">
              {index + 1} of {images.length}
            </span>
          )}
          {image.path && (
            <span className="image-viewer__path" title={image.path}>
              {image.path}
            </span>
          )}
          <span className="image-viewer__spacer" />
          {openError && (
            <span className="image-viewer__error" role="alert">
              {openError}
            </span>
          )}
          {image.path && onOpenFile && (
            <button type="button" className="btn btn--sm" onClick={openFile} title="Open in the default app">
              Open file
            </button>
          )}
          <button type="button" className="btn btn--sm" onClick={onClose} aria-label="Close" data-autofocus>
            ✕
          </button>
        </div>
        <div className="image-viewer__stage">
          {many && (
            <button type="button" className="image-viewer__arrow" onClick={() => go(-1)} aria-label="Previous image">
              ‹
            </button>
          )}
          <img className="image-viewer__image" src={image.src} alt={image.caption ?? image.label} />
          {many && (
            <button type="button" className="image-viewer__arrow" onClick={() => go(1)} aria-label="Next image">
              ›
            </button>
          )}
        </div>
        {image.caption && <p className="image-viewer__caption">{image.caption}</p>}
      </div>
    </div>
  )
}
