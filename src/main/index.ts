import { app, screen, BrowserWindow, dialog } from 'electron'
import type { Event as ElectronEvent } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { APP_NAME } from '@shared/constants'
import { openExternalSafely } from './safeExternal'
import { isAllowedNavigation } from './navigation'
import { loadWindowState, saveWindowState, pickStartupBounds } from './window-state'
import { registerIpc } from './ipc'
import { buildAppMenu } from './menu'
import { killAllShells } from './agent/shells'
import { attachPreviewHost, destroyAllPreviewPanes } from './preview'
import { killAllTerminals } from './terminal'
import { clearCheckpoints } from './agent/checkpoints'
import { disconnectAllMcp } from './mcp/manager'
import { initUpdates } from './updater'
import { log } from './logger'
import { pruneRecentWorkspaces } from './store'
import { setUserDataDir } from './userData'
import { wireAgentHost } from './wireAgentHost'
import { wireLocalhostCapture } from './localhostCapture'
import { activeRunCount } from './agent/loop'
import { shouldConfirmQuit, quitConfirmDetail } from './quit-guard'
import { parseHeadlessArgs } from './headless'
import { parseTuiArgs } from './tui'
import { runTuiEntry, runHeadlessEntry } from './terminalEntry'
import { activeBackendId, isSandboxed } from './sandbox'

// Log uncaught failures instead of letting them vanish (or crash silently). We
// don't force-exit: in a GUI app a stray async error shouldn't kill the window.
process.on('uncaughtException', (err) => log.error('uncaughtException', err))
process.on('unhandledRejection', (reason) => log.error('unhandledRejection', reason))

// Set the app name BEFORE the `ready` event. `app.getPath('userData')` and the
// macOS Keychain service name that `safeStorage` uses for API keys are both
// derived from the app name and are LOCKED in once the app is ready — calling
// `setName` later (inside `whenReady`) changes `getName()` but not the already
// resolved userData/Keychain, so stored keys would land in / be read from an
// inconsistent location and silently fail to persist.
app.setName(APP_NAME)

// Bind the shared shell modules (store/secrets/conversations/logger/…) to
// Electron's per-user profile dir. They read it via the userData seam instead of
// importing electron, so the standalone CLI can wire the same path Electron-free.
setUserDataDir(app.getPath('userData'))

// Bind the agent engine to its Electron-backed host capabilities before any run
// can start (all three clients — GUI, headless, TUI — boot through here). The
// engine never imports electron/store/secrets, so these are the wiring points:
// settings + secret storage, and the view_localhost screenshot backend.
wireAgentHost()
wireLocalhostCapture()

let mainWindow: BrowserWindow | null = null

// Quit-confirmation state, shared by the two guards below. `quitConfirmed` lets the
// re-issued quit pass straight through; `quitPrompting` swallows repeat quit
// gestures while the dialog is already open.
let quitConfirmed = false
let quitPrompting = false

/** Ask whether to tear down live runs. Resolves true when the user picks "Quit anyway". */
async function confirmQuitWithLiveRuns(
  win: BrowserWindow | undefined,
  running: number
): Promise<boolean> {
  const { response } = await dialog.showMessageBox(win!, {
    type: 'warning',
    buttons: ['Quit anyway', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: APP_NAME,
    message: running === 1 ? 'A chat is still running.' : 'Chats are still running.',
    detail: quitConfirmDetail(running)
  })
  return response === 0
}

/**
 * Shared guard for both quit paths: cancel the in-progress quit/close, confirm if
 * any run is live, and re-issue the quit only once the user agrees. Wired to
 * `before-quit` (⌘Q and File→Quit, where a window is still alive) and, on
 * Windows/Linux, to the window's `close` (the usual quit gesture there — and the
 * only place a dialog can still be parented, since `before-quit` fires after the
 * window is destroyed). Nothing live → the quit proceeds untouched.
 */
function guardQuitWithLiveRuns(e: ElectronEvent, win: BrowserWindow | undefined): void {
  if (quitConfirmed) return
  const running = activeRunCount()
  if (!shouldConfirmQuit(running)) return
  e.preventDefault()
  if (quitPrompting) return
  quitPrompting = true
  confirmQuitWithLiveRuns(win, running)
    .then((ok) => {
      quitPrompting = false
      if (ok) {
        quitConfirmed = true
        app.quit()
      }
    })
    .catch((err) => {
      // A failed prompt must not trap the user: clear the flag so the next quit
      // attempt re-prompts rather than silently swallowing every future quit.
      quitPrompting = false
      log.error('quit confirmation dialog failed', err)
    })
}

function createWindow(): void {
  // Fill the primary display's work area on a fresh install; restore the user's
  // saved bounds once they've resized or moved the window (see window-state.ts).
  const bounds = pickStartupBounds(
    loadWindowState(),
    screen.getPrimaryDisplay().workArea,
    screen.getAllDisplays().map((d) => d.workArea)
  )

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 720,
    minHeight: 560,
    show: false,
    title: APP_NAME,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0e0f12',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // The live Preview dock overlays native WebContentsViews on this window; point
  // the manager at it, and tear every pane down when the window goes away so the
  // views (and their dev-server connections) don't leak.
  attachPreviewHost(mainWindow)
  mainWindow.on('closed', () => destroyAllPreviewPanes())

  // On Windows/Linux, closing the window quits the app (window-all-closed →
  // app.quit()), so the live-run confirmation has to happen here — while the
  // window still exists to host the dialog. `before-quit` fires only afterward,
  // once the window is destroyed, which is too late. macOS intentionally has no
  // close guard: closing the window there doesn't quit (the run keeps running and
  // the window reopens from the dock), so ⌘Q is handled by before-quit instead.
  if (process.platform !== 'darwin') {
    mainWindow.on('close', (e) => guardQuitWithLiveRuns(e, mainWindow ?? undefined))
  }

  // Remember the window's position and size after the user resizes or moves it,
  // so the next launch reopens exactly there instead of refilling the desktop.
  // Debounced to coalesce the stream of events a drag produces into one write.
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  const rememberBounds = (): void => {
    if (!mainWindow || mainWindow.isFullScreen()) return
    if (saveTimer) clearTimeout(saveTimer)
    const win = mainWindow
    saveTimer = setTimeout(() => {
      if (!win.isDestroyed()) saveWindowState(win.getBounds())
    }, 400)
  }
  mainWindow.on('resize', rememberBounds)
  mainWindow.on('move', rememberBounds)

  // Open external links in the user's browser, never in-app — and only http(s)/
  // mailto, so a crafted link in rendered content (markdown, terminal output)
  // can't route a dangerous scheme (file:, custom app URLs) to openExternal.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    openExternalSafely(details.url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  const indexFile = join(__dirname, '../renderer/index.html')
  const startUrl = devUrl ?? pathToFileURL(indexFile).toString()

  // Pin the main frame to its own document. The renderer holds the privileged
  // `window.api` bridge, so a top-level navigation to any other origin must never
  // replace it (a dropped `file://`, a form submit in rendered untrusted content,
  // a stray `location =`). `setWindowOpenHandler` above only covers *new* windows;
  // these cover same-frame navigations and redirects. Off-allowlist http(s) is
  // handed to the external browser; any other scheme is silently dropped. The
  // view_localhost capture window manages its own (loopback-only) policy.
  const guardNavigation = (e: ElectronEvent, url: string): void => {
    if (isAllowedNavigation(url, startUrl, devUrl)) return
    e.preventDefault()
    openExternalSafely(url)
  }
  mainWindow.webContents.on('will-navigate', guardNavigation)
  mainWindow.webContents.on('will-redirect', guardNavigation)

  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(indexFile)
  }
}

// Interactive terminal mode: `Houston -i [--cwd dir] [--approval policy] ...`.
// A stay-resident REPL with no window; checked before headless so a lone `-i`
// (no `-p`) picks the interactive path.
const tui = parseTuiArgs(process.argv, process.cwd())

// One-shot headless mode: `Houston -p "<prompt>" [--cwd dir] [--full-auto] [--json]`.
// Runs the agent without a window and exits with a status code; everything else
// (GUI, IPC, auto-update) is skipped.
const headless = tui ? null : parseHeadlessArgs(process.argv, process.cwd())

if (tui) {
  // The full client wiring lives in terminalEntry.ts, shared verbatim with the
  // standalone CLI (src/cli) — only the exit call is Electron's.
  app.whenReady().then(async () => {
    app.exit(await runTuiEntry(tui))
  })
} else if (headless) {
  app.whenReady().then(async () => {
    app.exit(await runHeadlessEntry(headless))
  })
} else {
  app.whenReady().then(() => {
    log.info(`Houston ${app.getVersion()} starting`)
    log.info(`sandbox backend = ${activeBackendId()} (sandboxed=${isSandboxed()})`)
    // Drop recents whose folder vanished since last launch (e.g. a worktree removed
    // with its chat) so a deleted dir can't seed the next new chat's workspace.
    pruneRecentWorkspaces()
    registerIpc()
    buildAppMenu()
    createWindow()
    initUpdates()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Quitting out from under live runs (⌘Q / File→Quit, where the window is still
// alive) silently aborts them and drops queued input — confirm first. The
// window-close path on Windows/Linux is covered by the close guard in
// createWindow. (Headless uses `app.exit`, which skips before-quit.)
app.on('before-quit', (e) =>
  guardQuitWithLiveRuns(e, BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? undefined)
)

// Don't leave the agent's background shells or terminals running after the app exits.
app.on('will-quit', () => {
  destroyAllPreviewPanes()
  killAllShells()
  killAllTerminals()
  clearCheckpoints()
  disconnectAllMcp()
})
