import { app } from 'electron'
import electronUpdater from 'electron-updater'
import { shouldAutoUpdate } from './update-policy'

/**
 * Background auto-update via electron-updater. A no-op in dev/test; in packaged
 * builds it checks the GitHub Releases feed (configured in electron-builder.yml's
 * `publish` block) and logs whether a newer version is available.
 *
 * It deliberately does NOT auto-download or auto-install. This build is currently
 * unsigned (electron-builder.yml: `identity: null`), so electron-updater has no
 * Apple Developer ID signature to verify a downloaded package against — silently
 * installing whatever the feed serves would make the release pipeline a remote-
 * code-execution boundary. Once the app is code-signed + notarized, flip
 * `autoDownload`/`autoInstallOnAppQuit` on so signature verification is meaningful.
 *
 * Failures are logged, never thrown — a missing/unreachable feed must not crash.
 */
export function initAutoUpdate(): void {
  if (!shouldAutoUpdate(app.isPackaged)) return

  const { autoUpdater } = electronUpdater
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  autoUpdater.on('error', (err) => console.error('[updater] error:', err?.message ?? err))
  autoUpdater.on('update-available', (info) =>
    console.log('[updater] update available:', info?.version, '(download manually until signed)')
  )

  void autoUpdater
    .checkForUpdates()
    .catch((e: unknown) => console.error('[updater] check failed:', (e as Error)?.message ?? e))
}
