import { useEffect, useRef, useState } from 'react'
import { useFocusTrap } from '../lib/useFocusTrap'

/**
 * Help → Report an Issue…: shows the exact text a new GitHub issue will start with
 * (the app version, the platform and a summary of the diagnostics, with no logs, paths
 * or keys) before anything opens. "Open GitHub" opens the new-issue page in the browser
 * with that text filled in; nothing is sent until the user submits it there.
 */
export function IssueReportModal({ onClose }: { onClose: () => void }): JSX.Element {
  const [body, setBody] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    window.api
      .getIssueReport()
      .then((text) => {
        if (live) setBody(text)
      })
      .catch(() => {
        if (live) setFailed(true)
      })
    return () => {
      live = false
    }
  }, [])

  const dialogRef = useRef<HTMLDivElement>(null)
  useFocusTrap(dialogRef, onClose)

  const open = async (): Promise<void> => {
    await window.api.openIssueReport().catch(() => false)
    onClose()
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal modal--issue"
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="issue-title"
        aria-describedby="issue-desc"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal__head">
          <h2 id="issue-title">Report an issue</h2>
          <button className="modal__close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="issue-report">
          <p id="issue-desc" className="issue-report__desc">
            This opens a new issue on GitHub in your browser, starting with the text below. It
            includes your Houston version, platform, and a summary of the diagnostics. It includes
            no logs, file paths, or keys. Describe what happened there before you submit.
          </p>
          {failed ? (
            <p className="issue-report__desc" role="alert">
              Couldn&rsquo;t gather the diagnostics. You can still open a blank issue on GitHub.
            </p>
          ) : (
            <pre className="issue-report__body" aria-label="Text the issue will start with" tabIndex={0}>
              {body ?? 'Gathering diagnostics…'}
            </pre>
          )}
        </div>
        <div className="modal__foot">
          <button type="button" className="btn btn--sm" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--sm btn--accent"
            onClick={() => void open()}
            disabled={body === null && !failed}
          >
            Open GitHub
          </button>
        </div>
      </div>
    </div>
  )
}
