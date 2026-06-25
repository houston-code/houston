import type { UpdateCheckResult } from '@shared/update'

/** The "update available" shape, the only one the banner renders. */
type Available = Extract<UpdateCheckResult, { status: 'available' }>

/**
 * Persistent banner shown when a newer version is available — surfaced by the
 * on-launch auto-check and the manual "Check for updates" button. It doesn't
 * auto-dismiss; the user dismisses it for the session, and it reappears on the
 * next launch's check until they're on the new version. The build is unsigned,
 * so the CTA opens the Releases page to download rather than installing in-app
 * (the link routes through the main process's window-open handler → browser).
 */
export function UpdateBanner({
  update,
  onDismiss
}: {
  update: Available | null
  onDismiss: () => void
}): JSX.Element | null {
  if (!update) return null
  return (
    <div className="update-banner" role="status">
      <span className="update-banner__icon" aria-hidden="true">
        ↑
      </span>
      <span className="update-banner__label">
        Houston <strong>{update.latestVersion}</strong> is available — you have{' '}
        {update.currentVersion}.
      </span>
      <a
        className="btn btn--sm btn--accent"
        href={update.releaseUrl}
        target="_blank"
        rel="noreferrer"
      >
        Download
      </a>
      <button
        className="update-banner__dismiss"
        onClick={onDismiss}
        aria-label="Dismiss update notice"
        title="Dismiss"
      >
        ✕
      </button>
    </div>
  )
}
