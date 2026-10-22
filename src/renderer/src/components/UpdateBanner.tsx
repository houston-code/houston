import type {
  UpdateCheckResult,
  UpdateDownloaded,
  UpdateDownloadProgress,
  UpdateInstallFailed
} from '@shared/update'

/** The "update available" shape, the only one the banner renders. */
type Available = Extract<UpdateCheckResult, { status: 'available' }>

/**
 * Persistent update banner. Progresses through up to four states depending on the
 * platform:
 *
 *  - **available** — a newer version exists. On unsigned builds (Windows/Linux) this
 *    is the whole story: a manual "Download" link to the website. On signed
 *    macOS (`update.autoInstall`) the download starts automatically, so the banner
 *    shows "Downloading…" and moves on.
 *  - **downloading** — the signed-macOS auto-download is in flight; shows a progress
 *    bar + percentage.
 *  - **downloaded** — macOS has verified and staged the update; shows a "Restart to
 *    install" button that quits, applies, and relaunches (it would otherwise install on
 *    the next quit).
 *  - **failed** — macOS refused the downloaded update (its signature didn't match the
 *    installed app), so it can't install in place; shows the manual "Download" link.
 *
 * The user can dismiss it for the session; the next check (on launch, then every 6
 * hours) re-surfaces it until they're on the new version. While the macOS download is
 * still running, the close button reads "Cancel download" and stops it, so the update
 * isn't installed on the next quit.
 */
export function UpdateBanner({
  update,
  progress,
  downloaded,
  failed,
  onInstall,
  onDismiss
}: {
  update: Available | null
  progress: UpdateDownloadProgress | null
  downloaded: UpdateDownloaded | null
  failed: UpdateInstallFailed | null
  onInstall: () => void
  onDismiss: () => void
}): JSX.Element | null {
  const closeButton = (label: string, title: string): JSX.Element => (
    <button className="update-banner__dismiss" onClick={onDismiss} aria-label={label} title={title}>
      ✕
    </button>
  )
  const dismiss = closeButton('Dismiss update notice', 'Dismiss')
  // While the download runs, closing the banner stops it (see useUpdateBanner).
  const cancel = closeButton('Cancel update download', 'Cancel download')

  // macOS refused the download, so a manual install is the only way forward. Takes
  // precedence over every other state: none of them can install it anymore.
  if (failed) {
    return (
      <div className="update-banner" role="status">
        <span className="update-banner__icon" aria-hidden="true">
          ↑
        </span>
        <span className="update-banner__label">
          Houston <strong>{failed.version}</strong> couldn’t be installed automatically.
        </span>
        <a
          className="btn btn--sm btn--accent"
          href={failed.releaseUrl}
          target="_blank"
          rel="noreferrer"
        >
          Download
        </a>
        {dismiss}
      </div>
    )
  }

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
        {cancel}
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
          Houston <strong>{update.latestVersion}</strong> is available. You have{' '}
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
        {update.autoInstall ? cancel : dismiss}
      </div>
    )
  }

  return null
}
