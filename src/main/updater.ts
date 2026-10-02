import { app, BrowserWindow, dialog } from 'electron'
import type { MessageBoxOptions } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateInfo } from 'electron-updater'
import { IPC } from '@shared/constants'
import {
  DOWNLOAD_URL,
  highlightsFor,
  updateErrorHint,
  type UpdateCheckResult,
  type UpdateDownloaded,
  type UpdateDownloadProgress,
  type WhatsNew
} from '@shared/update'
import { shouldAutoInstallUpdates, shouldAutoUpdate, shouldShowWhatsNew } from './update-policy'
import { readLastSeenVersion, writeLastSeenVersion } from './update-state'
import { openExternalSafely } from './safeExternal'

/**
 * App updates, in two parts:
 *
 *  1. Update-available check — via electron-updater against the GitHub Releases
 *     feed (configured in electron-builder.yml's `publish` block). Runs on launch,
 *     then every UPDATE_CHECK_INTERVAL_MS while the app stays open, and on demand
 *     from the "Check for updates" button / menu item; all surface a persistent
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
 * the manual path (the banner links to the website's download page) until they are
 * signed too. Auto-
 * installing an unverifiable package would make the release pipeline a remote-code-
 * execution boundary, which is why the gate is per-platform rather than global.
 *
 * Failures are logged, never thrown — a missing/unreachable feed must not crash.
 */

/** How often a long-running app re-checks the feed, so a release published while
 *  Houston stays open still surfaces without a restart or a manual check. */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/** Staged once at launch; handed to the renderer (one-shot) via IPC.updateWhatsNew. */
let pendingWhatsNew: WhatsNew | null = null

let configured = false

/** Version electron-updater has finished downloading (signed macOS), ready to install. */
let downloadedVersion: string | null = null

/** The in-flight background download kicked off by the last check, if any. */
let pendingDownload: Promise<unknown> | null = null

/** The in-flight feed check, shared so the periodic timer, launch check, and manual
 *  checks never run two at once. */
let inflightCheck: Promise<UpdateCheckResult> | null = null

/**
 * Runs before a restart-to-install; resolves false to cancel it. Wired by index.ts to
 * the same "chats / background tasks are still running" confirmation as ⌘Q (kept
 * injectable so this module doesn't pull the agent engine into its tests).
 */
let installGuard: () => Promise<boolean> = async () => true
let onInstallAborted: () => void = () => {}

/** Install the pre-restart confirmation (and the undo for a restart that never happened). */
export function setInstallGuard(guard: () => Promise<boolean>, onAborted?: () => void): void {
  installGuard = guard
  onInstallAborted = onAborted ?? (() => {})
}

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
      // The download runs in the background; surface its progress and the "ready to
      // install" transition so the banner can show a bar + a Restart-to-install button
      // (in addition to the silent install-on-next-quit).
      autoUpdater.on('download-progress', (p) => {
        const payload: UpdateDownloadProgress = {
          percent: Math.round(p?.percent ?? 0),
          bytesPerSecond: Math.round(p?.bytesPerSecond ?? 0),
          transferred: p?.transferred ?? 0,
          total: p?.total ?? 0
        }
        broadcast(IPC.updateDownloadProgress, payload)
      })
      autoUpdater.on('update-downloaded', (info) => {
        console.log('[updater] downloaded', info?.version, '(ready to install)')
        downloadedVersion = info?.version ?? ''
        const payload: UpdateDownloaded = { version: info?.version ?? '' }
        broadcast(IPC.updateDownloaded, payload)
      })
    }
    configured = true
  }
  return autoUpdater
}

/**
 * Install a downloaded update now: confirm if work is still running, then quit,
 * apply, and relaunch. Wired to the banner's "Restart to install" button and the
 * menu dialog's Update button. A no-op where auto-install isn't supported (unsigned
 * Windows/Linux), which is also where nothing is ever downloaded to install.
 * Resolves true when the restart was started.
 */
export async function installUpdate(): Promise<boolean> {
  if (!shouldAutoInstallUpdates()) return false
  if (!(await installGuard())) return false
  try {
    electronUpdater.autoUpdater.quitAndInstall()
    return true
  } catch (e) {
    console.error('[updater] install failed:', (e as Error)?.message ?? e)
    onInstallAborted()
    return false
  }
}

/**
 * The menu dialog's Update action on auto-install builds: finish the background
 * download if it's still running (starting one if none is), then install. Throws if
 * the download fails, so the caller can offer the manual route instead.
 */
async function downloadAndInstall(): Promise<boolean> {
  if (downloadedVersion === null) {
    await (pendingDownload ?? configureUpdater().downloadUpdate())
  }
  return installUpdate()
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

/** Send a payload to every open window (drives the update banner + progress states). */
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/**
 * Check the update feed. Returns a structured result for the manual button, and
 * — when a newer version exists — also broadcasts it so the persistent banner
 * appears app-wide regardless of who triggered the check.
 */
export function checkForUpdates(): Promise<UpdateCheckResult> {
  inflightCheck ??= runCheck().finally(() => {
    inflightCheck = null
  })
  return inflightCheck
}

async function runCheck(): Promise<UpdateCheckResult> {
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
    if (result?.downloadPromise) {
      // Keep the background download for the menu's Update button to await; its
      // failure is already reported via the 'error' event, so don't let it go unhandled.
      const download = result.downloadPromise
      pendingDownload = download
      download.then(
        () => {
          if (pendingDownload === download) pendingDownload = null
        },
        () => {
          if (pendingDownload === download) pendingDownload = null
        }
      )
    }
    if (result?.isUpdateAvailable) {
      const payload = {
        status: 'available' as const,
        currentVersion,
        latestVersion: result.updateInfo.version,
        releaseUrl: DOWNLOAD_URL,
        notes: notesText(result.updateInfo),
        autoInstall: shouldAutoInstallUpdates()
      }
      broadcast(IPC.updateAvailable, payload)
      return payload
    }
    return { status: 'up-to-date', currentVersion }
  } catch (e) {
    const message = (e as Error)?.message ?? String(e)
    console.error('[updater] check failed:', message)
    return { status: 'error', currentVersion, message }
  }
}

/** What the menu dialog's Update button (index 0) does. */
export type MenuUpdateAction =
  /** Signed macOS: download if needed, then restart into the new version. */
  | { kind: 'install' }
  /** Unsigned Windows/Linux: nothing can be verified + installed in place, so open
   *  the website's download page for a manual download. */
  | { kind: 'open'; url: string }

/**
 * Map a check result to the native dialog the menu item should show. Split out as
 * a pure function so the wording/branching is unit-testable without Electron.
 * `action` is non-null only for the available case, where the dialog offers an
 * Update button (button index 0).
 */
export function menuUpdateDialog(result: UpdateCheckResult): {
  options: MessageBoxOptions
  action: MenuUpdateAction | null
} {
  switch (result.status) {
    case 'available': {
      const install = result.autoInstall === true
      return {
        action: install ? { kind: 'install' } : { kind: 'open', url: result.releaseUrl },
        options: {
          type: 'info',
          buttons: ['Update', 'Later'],
          defaultId: 0,
          cancelId: 1,
          title: 'Update available',
          message: `Houston ${result.latestVersion} is available.`,
          detail: install
            ? `You have ${result.currentVersion}. Houston will restart to install the update.`
            : `You have ${result.currentVersion}. Update opens the download page for the new version.`
        }
      }
    }
    case 'up-to-date':
      return {
        action: null,
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
        action: null,
        options: {
          type: 'info',
          buttons: ['OK'],
          defaultId: 0,
          title: 'Check for updates',
          message: 'Update checks run only in packaged builds.',
          detail: `You’re running Houston ${result.currentVersion} from a development build.`
        }
      }
    case 'error': {
      // The raw error is already logged by checkForUpdates; show a hint, not the error.
      const hint = updateErrorHint(result.message)
      return {
        action: null,
        options: {
          type: 'warning',
          buttons: ['OK'],
          defaultId: 0,
          title: 'Check for updates',
          message: 'Couldn’t check for updates.',
          ...(hint ? { detail: hint } : {})
        }
      }
    }
  }
}

/** Show a native message box, parented to the focused window when there is one. */
async function showBox(options: MessageBoxOptions): Promise<number> {
  const win = BrowserWindow.getFocusedWindow()
  const { response } = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options)
  return response
}

/**
 * Menu-driven "Check for Updates…": runs the same feed check as the in-app button
 * but reports every outcome through a native dialog, the way a desktop app's menu
 * item is expected to. The available case still broadcasts the in-app banner (via
 * checkForUpdates), so both entry points stay consistent. Its Update button installs
 * in place on signed macOS (waiting out the background download first; the banner
 * shows its progress) and opens the website's download page on unsigned platforms.
 */
export async function checkForUpdatesFromMenu(): Promise<void> {
  const result = await checkForUpdates()
  const { options, action } = menuUpdateDialog(result)
  const response = await showBox(options)
  if (!action || response !== 0) return
  if (action.kind === 'open') {
    openExternalSafely(action.url)
    return
  }
  try {
    await downloadAndInstall()
  } catch (e) {
    console.error('[updater] download failed:', (e as Error)?.message ?? e)
    const hint = updateErrorHint((e as Error)?.message ?? String(e))
    const choice = await showBox({
      type: 'warning',
      buttons: ['Open download page', 'Close'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update',
      message: 'Couldn’t download the update.',
      detail: hint ?? 'You can download the new version from the website instead.'
    })
    if (choice === 0) openExternalSafely(DOWNLOAD_URL)
  }
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

let periodicTimer: ReturnType<typeof setInterval> | null = null

/** Run a background check and log a find (the banner is broadcast by the check itself). */
function backgroundCheck(): void {
  void checkForUpdates().then((r) => {
    if (r.status === 'available') {
      console.log('[updater] update available:', r.latestVersion)
    }
  })
}

/**
 * Wire up updates at startup: stage "What's new", kick off the launch check, and
 * keep re-checking every UPDATE_CHECK_INTERVAL_MS for as long as the app runs.
 */
export function initUpdates(): void {
  stageWhatsNew()
  if (!shouldAutoUpdate(app.isPackaged)) return
  backgroundCheck()
  if (periodicTimer === null) {
    periodicTimer = setInterval(backgroundCheck, UPDATE_CHECK_INTERVAL_MS)
    // Never keep the process alive just for the update timer.
    periodicTimer.unref?.()
  }
}
