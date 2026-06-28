import { app, screen, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { APP_NAME } from '@shared/constants'
import { openExternalSafely } from './safeExternal'
import { loadWindowState, saveWindowState, pickStartupBounds } from './window-state'
import { registerIpc } from './ipc'
import { buildAppMenu } from './menu'
import { killAllShells } from './agent/shells'
import { killAllTerminals } from './terminal'
import { clearCheckpoints } from './agent/checkpoints'
import { disconnectAllMcp } from './mcp/manager'
import { initUpdates } from './updater'
import { log } from './logger'
import { getSettings } from './store'
import { startRun, resolveApproval, resolveQuestion } from './agent/loop'
import { parseHeadlessArgs, runHeadless } from './headless'
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

let mainWindow: BrowserWindow | null = null

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
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// One-shot headless mode: `Houston -p "<prompt>" [--cwd dir] [--full-auto] [--json]`.
// Runs the agent without a window and exits with a status code; everything else
// (GUI, IPC, auto-update) is skipped.
const headless = parseHeadlessArgs(process.argv, process.cwd())

if (headless) {
  app.whenReady().then(async () => {
    let code = 1
    try {
      code = await runHeadless(headless, {
        getSettings,
        startRun,
        resolveApproval,
        resolveQuestion,
        out: (s) => process.stdout.write(s),
        err: (s) => process.stderr.write(s)
      })
    } catch (e) {
      process.stderr.write(`Fatal: ${(e as Error).message}\n`)
    } finally {
      killAllShells()
      disconnectAllMcp()
      app.exit(code)
    }
  })
} else {
  app.whenReady().then(() => {
    log.info(`Houston ${app.getVersion()} starting`)
    log.info(`sandbox backend = ${activeBackendId()} (sandboxed=${isSandboxed()})`)
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

// Don't leave the agent's background shells or terminals running after the app exits.
app.on('will-quit', () => {
  killAllShells()
  killAllTerminals()
  clearCheckpoints()
  disconnectAllMcp()
})
