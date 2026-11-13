import { useEffect, useState } from 'react'
import { Icon } from './Icon'

/**
 * One-time offer to import from other tools, shown the first time Houston finds
 * instruction files, MCP servers, skills or commands that other coding tools keep
 * (main decides; see importIpc.ts). It imports nothing itself: "Review" opens
 * Settings > Import, where the user picks what to copy. Either answer is recorded and
 * the offer never returns; the Settings page stays available.
 */
export function ImportNotice({
  workspace,
  onReview
}: {
  workspace: string | null
  /** Open Settings at the Import page. */
  onReview: () => void
}): JSX.Element | null {
  const [show, setShow] = useState(false)

  useEffect(() => {
    let live = true
    Promise.resolve()
      .then(() => window.api.getImportOffer(workspace))
      .then((s) => {
        if (live) setShow(s === true)
      })
      .catch(() => {
        // Non-fatal: stay hidden rather than nag on bad data.
      })
    return () => {
      live = false
    }
  }, [workspace])

  if (!show) return null

  const answer = (review: boolean): void => {
    setShow(false)
    void window.api.answerImportOffer().catch(() => {})
    if (review) onReview()
  }

  return (
    <section className="rules-notice" role="region" aria-labelledby="import-notice-title">
      <span className="rules-notice__icon" aria-hidden="true">
        <Icon name="file" size={16} />
      </span>
      <div className="rules-notice__body">
        <p className="rules-notice__title" id="import-notice-title">
          Bring your setup from other tools
        </p>
        <p className="rules-notice__text">
          Houston found instructions, MCP servers, skills or commands that other coding tools keep
          on this computer. Review them to choose what to copy into Houston. The originals stay as
          they are.
        </p>
        <div className="rules-notice__actions">
          <button type="button" className="btn btn--sm btn--accent" onClick={() => answer(true)}>
            Review
          </button>
          <button type="button" className="btn btn--sm" onClick={() => answer(false)}>
            Not now
          </button>
          <span className="rules-notice__hint">You can import later from Settings &gt; Import.</span>
        </div>
      </div>
    </section>
  )
}
