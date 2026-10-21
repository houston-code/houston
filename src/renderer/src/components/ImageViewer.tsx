import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useFocusTrap } from '../lib/useFocusTrap'
import { stepIndex, type ViewerImage } from '../lib/imageViewer'

/** What an action reports back: a short note for the status line, or an error. */
export type ViewerActionResult = { ok: true; message: string } | { ok: false; message: string } | null

const failed = (what: 'copy' | 'save'): ViewerActionResult => ({ ok: false, message: `Couldn't ${what} the image.` })

/**
 * Full-window viewer for one set of images: the current image as large as the
 * window allows, its label and caption, and arrows (or ←/→) to step through the
 * set. An image with something to compare against can switch to a slider view of
 * the two. Esc, the ✕ button, or a click on the backdrop closes it, and focus
 * returns to whatever opened it.
 */
export function ImageViewer({
  images,
  initialIndex,
  onClose,
  onOpenFile,
  onShowInFiles,
  onCopy,
  onSave
}: {
  images: ViewerImage[]
  initialIndex: number
  onClose: () => void
  /** Open the image's file in its default app; resolves to an error message on failure. */
  onOpenFile?: (path: string) => Promise<string | null>
  /** Show the image's file in the Files panel; returns why it can't, or null. */
  onShowInFiles?: (path: string) => string | null
  onCopy?: (image: ViewerImage) => Promise<ViewerActionResult>
  onSave?: (image: ViewerImage) => Promise<ViewerActionResult>
}): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  useFocusTrap(ref, onClose)
  const [index, setIndex] = useState(() => stepIndex(initialIndex, 0, images.length))
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null)
  const [comparing, setComparing] = useState(false)
  const [divider, setDivider] = useState(50)
  const image = images[index]
  if (!image) return null
  const many = images.length > 1
  const showCompare = comparing && image.compare !== undefined

  const go = (delta: number): void => {
    setStatus(null)
    setIndex((i) => stepIndex(i, delta, images.length))
  }
  const onKeyDown = (e: ReactKeyboardEvent): void => {
    // The comparison slider uses the arrow keys itself.
    if (!many || (e.target instanceof HTMLInputElement && e.target.type === 'range')) return
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      go(-1)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      go(1)
    }
  }
  const report = (result: ViewerActionResult): void => {
    if (result) setStatus(result)
  }
  const openFile = (): void => {
    if (!image.path || !onOpenFile) return
    void onOpenFile(image.path).then((err) => setStatus(err ? { ok: false, message: err } : null))
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
          {status && (
            <span
              className={`image-viewer__status${status.ok ? '' : ' image-viewer__status--error'}`}
              role={status.ok ? 'status' : 'alert'}
            >
              {status.message}
            </span>
          )}
          {image.compare && (
            <button
              type="button"
              className="btn btn--sm"
              aria-pressed={comparing}
              onClick={() => setComparing((c) => !c)}
              title={`Compare with ${image.compare.label}`}
            >
              Compare
            </button>
          )}
          {image.path && onShowInFiles && (
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => {
                const err = onShowInFiles(image.path!)
                if (err) setStatus({ ok: false, message: err })
              }}
            >
              Show in Files
            </button>
          )}
          {image.path && onOpenFile && (
            <button type="button" className="btn btn--sm" onClick={openFile} title="Open in the default app">
              Open file
            </button>
          )}
          {onCopy && (
            <button type="button" className="btn btn--sm" onClick={() => void onCopy(image).then(report, () => report(failed('copy')))}>
              Copy image
            </button>
          )}
          {onSave && (
            <button type="button" className="btn btn--sm" onClick={() => void onSave(image).then(report, () => report(failed('save')))}>
              Save image…
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
          {showCompare ? (
            <div className="image-viewer__compare">
              <img className="image-viewer__compare-base" src={image.compare!.src} alt={image.compare!.label} />
              <img
                className="image-viewer__compare-top"
                src={image.src}
                alt={image.caption ?? image.label}
                style={{ clipPath: `inset(0 0 0 ${divider}%)` }}
              />
              <div className="image-viewer__compare-line" style={{ left: `${divider}%` }} aria-hidden="true" />
              <span className="image-viewer__compare-tag image-viewer__compare-tag--left">{image.compare!.label}</span>
              <span className="image-viewer__compare-tag image-viewer__compare-tag--right">{image.label}</span>
              <input
                className="image-viewer__compare-range"
                type="range"
                min={0}
                max={100}
                value={divider}
                onChange={(e) => setDivider(Number(e.target.value))}
                aria-label={`Divider between ${image.compare!.label} and ${image.label}`}
              />
            </div>
          ) : (
            <img className="image-viewer__image" src={image.src} alt={image.caption ?? image.label} />
          )}
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
