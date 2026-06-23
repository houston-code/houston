import { app, shell, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { APP_NAME } from '@shared/constants'
import { registerIpc } from './ipc'
import { killAllShells } from './agent/shells'
import { clearCheckpoints } from './agent/checkpoints'
import { disconnectAllMcp } from './mcp/manager'
import { initAutoUpdate } from './updater'
import { log } from './logger'

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
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
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

  // Open external links in the user's browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  log.info(`Houston ${app.getVersion()} starting`)
  registerIpc()
  createWindow()
  initAutoUpdate()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Don't leave the agent's background shells running after the app exits.
app.on('will-quit', () => {
  killAllShells()
  clearCheckpoints()
  disconnectAllMcp()
})
