import { useRef } from 'react'
import { useFocusTrap } from '../lib/useFocusTrap'
import type { WhatsNew } from '@shared/update'

/**
 * Small one-shot popup shown after the app is updated and relaunched, with a
 * 1–2 line summary of what changed (bundled highlights for the running version).
 * Dismissing it is enough — the main process already recorded the new version,
 * so it won't reappear until the next upgrade.
 */
export function WhatsNewModal({
  info,
  onClose
}: {
  info: WhatsNew | null
  onClose: () => void
}): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  useFocusTrap(ref, onClose)
  if (!info) return null
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal modal--sm"
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="whatsnew-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal__head">
          <h2 id="whatsnew-title">What&rsquo;s new in {info.version}</h2>
        </div>
        <div className="modal__body">
          <p className="whatsnew__highlights">{info.highlights}</p>
        </div>
        <div className="modal__foot">
          <button className="btn btn--accent" onClick={onClose}>
            Got it
          </button>
        </div>
      </div>
    </div>
  )
}
