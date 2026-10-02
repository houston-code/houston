import type { KeyboardEvent } from 'react'
import type { WhatsNew } from '@shared/update'

/**
 * Small one-shot card shown after the app is updated and relaunched, with a 1–2
 * line summary of what changed (bundled highlights for the running version). It
 * sits in the bottom-right corner as a non-modal popup — no backdrop, no focus
 * steal — so it never blocks the app; the ✕ (or Escape while it has focus)
 * dismisses it. Dismissing is enough: the main process already recorded the new
 * version, so it won't reappear until the next upgrade.
 */
export function WhatsNewModal({
  info,
  onClose
}: {
  info: WhatsNew | null
  onClose: () => void
}): JSX.Element | null {
  if (!info) return null
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
    }
  }
  return (
    <div
      className="whatsnew"
      role="dialog"
      aria-modal="false"
      aria-labelledby="whatsnew-title"
      onKeyDown={onKeyDown}
    >
      <div className="whatsnew__head">
        <h2 id="whatsnew-title">What&rsquo;s new in {info.version}</h2>
        <button className="modal__close" onClick={onClose} aria-label="Close what’s new">
          ✕
        </button>
      </div>
      <p className="whatsnew__highlights">{info.highlights}</p>
    </div>
  )
}
