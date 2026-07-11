import { app, BrowserWindow, dialog } from 'electron'
import type { MessageBoxOptions } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateInfo } from 'electron-updater'
import { IPC } from '@shared/constants'
import { highlightsFor, type UpdateCheckResult, type WhatsNew } from '@shared/update'
import { shouldAutoInstallUpdates, shouldAutoUpdate, shouldShowWhatsNew } from './update-policy'
import { readLastSeenVersion, writeLastSeenVersion } from './update-state'
import { openExternalSafely } from './safeExternal'

/**
 * App updates, in two parts:
 *
 *  1. Update-available check — via electron-updater against the GitHub Releases
 *     feed (configured in electron-builder.yml's `publish` block). Runs on launch
 *     and on demand from the "Check for updates" button; both surface a persistent
 *     in-app banner when a newer version exists.
 *
 *  2. "What's new" — on launch we compare the running version against the one we
 *     recorded last time; if it changed, the app was updated, so we stage a
 *     one-shot popup with that version's bundled highlights.
 *
 * Auto-download/install is gated on the build being code-signed + notarized, so
 * electron-updater can verify a downloaded package against the running app before
 * replacing it (`shouldAutoInstallUpdates`). Only macOS is signed today, so there we
 * `autoDownload` and `autoInstallOnAppQuit`; Windows and Linux stay unsigned and keep
 * the manual path (the banner links to Releases) until they are signed too. Auto-
 * installing an unverifiable package would make the release pipeline a remote-code-
 * execution boundary, which is why the gate is per-platform rather than global.
 *
 * Failures are logged, never thrown — a missing/unreachable feed must not crash.
 */

/** Releases page the banner + menu link to for a manual download (used everywhere,
 *  and the only update path on the not-yet-signed Windows/Linux builds). Points at the
 *  PUBLIC releases repo where artifacts are actually published — must match the
 *  `publish` owner/repo in electron-builder.yml (the source repo is private). */
const RELEASES_URL = 'https://github.com/piyushvijay/houston-releases/releases'

/** Staged once at launch; handed to the renderer (one-shot) via IPC.updateWhatsNew. */
let pendingWhatsNew: WhatsNew | null = null

let configured = false

/** Apply the updater config + error logging exactly once. */
function configureUpdater(): typeof electronUpdater.autoUpdater {
  const { autoUpdater } = electronUpdater
  if (!configured) {
    // Only signed + notarized platforms (macOS today) auto-download and install in
    // place; unsigned ones (Windows/Linux) fall back to the manual-download banner.
    const autoInstall = shouldAutoInstallUpdates()
    autoUpdater.autoDownload = autoInstall
    autoUpdater.autoInstallOnAppQuit = autoInstall
    autoUpdater.on('error', (err) => console.error('[updater] error:', err?.message ?? err))
    if (autoInstall) {
      autoUpdater.on('update-downloaded', (info) =>
        console.log('[updater] downloaded', info?.version, '(installs on next quit)')
      )
    }
    configured = true
  }
  return autoUpdater
}

/** electron-updater's releaseNotes can be a string, a list, or null — flatten to text. */
function notesText(info: UpdateInfo): string | undefined {
  const notes = info.releaseNotes
  if (typeof notes === 'string') return notes.trim() || undefined
  if (Array.isArray(notes)) {
    const joined = notes
      .map((n) => n.note ?? '')
      .filter(Boolean)
      .join('\n')
      .trim()
    return joined || undefined
  }
  return undefined
}

/** Push an "update available" payload to every open window (drives the banner). */
function broadcastAvailable(payload: Extract<UpdateCheckResult, { status: 'available' }>): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.updateAvailable, payload)
  }
}

/**
 * Check the update feed. Returns a structured result for the manual button, and
 * — when a newer version exists — also broadcasts it so the persistent banner
 * appears app-wide regardless of who triggered the check.
 */
export async function checkForUpdates(): Promise<UpdateCheckResult> {
  const currentVersion = app.getVersion()
  if (!shouldAutoUpdate(app.isPackaged)) {
    return { status: 'disabled', currentVersion }
  }
  try {
    const autoUpdater = configureUpdater()
    // Cross-platform note: electron-updater reads the running platform's metadata feed
    // automatically (latest-mac.yml / latest.yml / latest-linux.yml). On Linux it only
    // works for the AppImage build (it keys off the APPIMAGE env var); a `.deb` install
    // throws here and is caught below → "error" (the user updates via their package
    // manager or a manual re-download). That degradation is expected, not a bug.
    const result = await autoUpdater.checkForUpdates()
    if (result?.isUpdateAvailable) {
      const payload = {
        status: 'available' as const,
        currentVersion,
        latestVersion: result.updateInfo.version,
        releaseUrl: RELEASES_URL,
        notes: notesText(result.updateInfo)
      }
      broadcastAvailable(payload)
      return payload
    }
    return { status: 'up-to-date', currentVersion }
  } catch (e) {
    const message = (e as Error)?.message ?? String(e)
    console.error('[updater] check failed:', message)
    return { status: 'error', currentVersion, message }
  }
}

/**
 * Map a check result to the native dialog the menu item should show. Split out as
 * a pure function so the wording/branching is unit-testable without Electron. The
 * `downloadUrl` is non-null only for the available case, where the dialog offers a
 * Download button (button index 0) that opens it.
 */
export function menuUpdateDialog(result: UpdateCheckResult): {
  options: MessageBoxOptions
  downloadUrl: string | null
} {
  switch (result.status) {
    case 'available':
      return {
        downloadUrl: result.releaseUrl,
        options: {
          type: 'info',
          buttons: ['Download', 'Later'],
          defaultId: 0,
          cancelId: 1,
          title: 'Update available',
          message: `Houston ${result.latestVersion} is available.`,
          detail: `You have ${result.currentVersion}. Download the new version to update.`
        }
      }
    case 'up-to-date':
      return {
        downloadUrl: null,
        options: {
          type: 'info',
          buttons: ['OK'],
          defaultId: 0,
          title: 'You’re up to date',
          message: 'You’re up to date.',
          detail: `Houston ${result.currentVersion} is the latest version.`
        }
      }
    case 'disabled':
      return {
        downloadUrl: null,
        options: {
          type: 'info',
          buttons: ['OK'],
          defaultId: 0,
          title: 'Check for updates',
          message: 'Update checks run only in packaged builds.',
          detail: `You’re running Houston ${result.currentVersion} from a development build.`
        }
      }
    case 'error':
      return {
        downloadUrl: null,
        options: {
          type: 'warning',
          buttons: ['OK'],
          defaultId: 0,
          title: 'Check for updates',
          message: 'Couldn’t check for updates.',
          detail: result.message
        }
      }
  }
}

/**
 * Menu-driven "Check for Updates…": runs the same feed check as the in-app button
 * but reports every outcome through a native dialog, the way a desktop app's menu
 * item is expected to. The available case still broadcasts the in-app banner (via
 * checkForUpdates), so both entry points stay consistent; here we additionally
 * offer a Download button that opens the Releases page — a manual alternative to
 * the auto-download/install-on-quit path, and the only route on unsigned platforms.
 */
export async function checkForUpdatesFromMenu(): Promise<void> {
  const result = await checkForUpdates()
  const { options, downloadUrl } = menuUpdateDialog(result)
  const win = BrowserWindow.getFocusedWindow() ?? undefined
  const { response } = await dialog.showMessageBox(win!, options)
  if (downloadUrl && response === 0) openExternalSafely(downloadUrl)
}

/**
 * Detect an upgrade since the last run and stage the "What's new" popup. Always
 * records the running version so the popup shows at most once per upgrade. Runs
 * regardless of the packaged gate (it's just version bookkeeping, a no-op churn
 * in dev where the version never changes).
 */
function stageWhatsNew(): void {
  const current = app.getVersion()
  const lastSeen = readLastSeenVersion()
  if (shouldShowWhatsNew(lastSeen, current)) {
    const highlights = highlightsFor(current)
    if (highlights) pendingWhatsNew = { version: current, highlights }
  }
  if (lastSeen !== current) {
    try {
      writeLastSeenVersion(current)
    } catch (e) {
      console.error('[updater] could not record version:', (e as Error)?.message ?? e)
    }
  }
}

/** The staged "What's new" payload, consumed once (cleared on read). */
export function takePendingWhatsNew(): WhatsNew | null {
  const v = pendingWhatsNew
  pendingWhatsNew = null
  return v
}

/** Wire up updates at startup: stage "What's new", then kick off the auto-check. */
export function initUpdates(): void {
  stageWhatsNew()
  if (!shouldAutoUpdate(app.isPackaged)) return
  void checkForUpdates().then((r) => {
    if (r.status === 'available') {
      console.log('[updater] update available:', r.latestVersion)
    }
  })
}
