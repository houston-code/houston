import type { UpdateCheckResult, UpdateDownloaded, UpdateDownloadProgress } from '@shared/update'

/** The "update available" shape, the only one the banner renders. */
type Available = Extract<UpdateCheckResult, { status: 'available' }>

/**
 * Persistent update banner. Progresses through up to three states depending on the
 * platform:
 *
 *  - **available** — a newer version exists. On unsigned builds (Windows/Linux) this
 *    is the whole story: a manual "Download" link to the Releases page. On signed
 *    macOS (`update.autoInstall`) the download starts automatically, so the banner
 *    shows "Downloading…" and moves on.
 *  - **downloading** — the signed-macOS auto-download is in flight; shows a progress
 *    bar + percentage.
 *  - **downloaded** — the update is ready; shows a "Restart to install" button that
 *    quits, applies, and relaunches (it would otherwise install on the next quit).
 *
 * The user can dismiss it for the session; the on-launch check re-surfaces it until
 * they're on the new version.
 */
export function UpdateBanner({
  update,
  progress,
  downloaded,
  onInstall,
  onDismiss
}: {
  update: Available | null
  progress: UpdateDownloadProgress | null
  downloaded: UpdateDownloaded | null
  onInstall: () => void
  onDismiss: () => void
}): JSX.Element | null {
  const dismiss = (
    <button
      className="update-banner__dismiss"
      onClick={onDismiss}
      aria-label="Dismiss update notice"
      title="Dismiss"
    >
      ✕
    </button>
  )

  // Ready to install — takes precedence over the earlier states.
  if (downloaded) {
    return (
      <div className="update-banner" role="status">
        <span className="update-banner__icon" aria-hidden="true">
          ↑
        </span>
        <span className="update-banner__label">
          Houston <strong>{downloaded.version}</strong> is ready to install.
        </span>
        <button className="btn btn--sm btn--accent" onClick={onInstall}>
          Restart to install
        </button>
        {dismiss}
      </div>
    )
  }

  // Downloading in the background (signed macOS auto-update).
  if (progress) {
    const pct = Math.max(0, Math.min(100, Math.round(progress.percent)))
    return (
      <div className="update-banner" role="status">
        <span className="update-banner__icon" aria-hidden="true">
          ↑
        </span>
        <span className="update-banner__label">
          Downloading update… {pct}%
          <span className="update-banner__progress" aria-hidden="true">
            <span className="update-banner__progress-fill" style={{ width: `${pct}%` }} />
          </span>
        </span>
        {dismiss}
      </div>
    )
  }

  // A newer version is available.
  if (update) {
    return (
      <div className="update-banner" role="status">
        <span className="update-banner__icon" aria-hidden="true">
          ↑
        </span>
        <span className="update-banner__label">
          Houston <strong>{update.latestVersion}</strong> is available — you have{' '}
          {update.currentVersion}.
        </span>
        {update.autoInstall ? (
          <span className="update-banner__hint">Downloading…</span>
        ) : (
          <a
            className="btn btn--sm btn--accent"
            href={update.releaseUrl}
            target="_blank"
            rel="noreferrer"
          >
            Download
          </a>
        )}
        {dismiss}
      </div>
    )
  }

  return null
}
