import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  UpdateCheckResult,
  UpdateDownloaded,
  UpdateDownloadProgress,
  UpdateInstallFailed
} from '@shared/update'

export interface UpdateBannerState {
  update: Extract<UpdateCheckResult, { status: 'available' }> | null
  progress: UpdateDownloadProgress | null
  downloaded: UpdateDownloaded | null
  failed: UpdateInstallFailed | null
  /** Hide the banner until the next check or a new download outcome. */
  dismiss: () => void
}

/**
 * The update banner's state, fed by the main process's updater broadcasts.
 *
 * Dismissing has to outlast the download: progress events keep arriving several times a
 * second, so merely clearing the state would bring the banner straight back. A dismissal
 * mutes progress until the next check announces the update again, or the download ends
 * in something the user can act on (ready to install, or refused by macOS).
 */
export function useUpdateBanner(): UpdateBannerState {
  const [update, setUpdate] = useState<UpdateBannerState['update']>(null)
  const [progress, setProgress] = useState<UpdateDownloadProgress | null>(null)
  const [downloaded, setDownloaded] = useState<UpdateDownloaded | null>(null)
  const [failed, setFailed] = useState<UpdateInstallFailed | null>(null)
  const dismissed = useRef(false)

  useEffect(() => {
    const unsubAvailable = window.api.onUpdateAvailable((u) => {
      dismissed.current = false
      setUpdate(u)
      // A newer release than the one macOS refused gets its own in-place attempt.
      setFailed((f) => (f && f.version !== u.latestVersion ? null : f))
    })
    const unsubProgress = window.api.onUpdateDownloadProgress((p) => {
      if (!dismissed.current) setProgress(p)
    })
    const unsubDownloaded = window.api.onUpdateDownloaded((d) => {
      dismissed.current = false
      setDownloaded(d)
      setProgress(null)
      setFailed(null)
    })
    // macOS refused the downloaded update: drop "Restart to install" for a download link.
    const unsubFailed = window.api.onUpdateInstallFailed((f) => {
      dismissed.current = false
      setFailed(f)
      setDownloaded(null)
      setProgress(null)
    })
    return () => {
      unsubAvailable()
      unsubProgress()
      unsubDownloaded()
      unsubFailed()
    }
  }, [])

  const dismiss = useCallback(() => {
    dismissed.current = true
    setUpdate(null)
    setProgress(null)
    setDownloaded(null)
    setFailed(null)
  }, [])

  return { update, progress, downloaded, failed, dismiss }
}
