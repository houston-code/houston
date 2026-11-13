import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { DEEP_LINK_SCHEME, deepLinkFromArgv } from '@shared/deepLink'
import { IPC } from '@shared/constants'
import type { MenuCommand } from '@shared/types'
import { createDeepLinkRouter, type DeepLinkRouter } from './deepLinks'
import { appWindows } from './helperWindows'
import { windowShowing } from './windows'
import { getSettings, rememberWorkspace } from './store'
import { conversationExists, listConversations } from './conversations'
import { log } from './logger'

/**
 * Electron side of `houston://` links: protocol registration, the single-instance
 * lock that forwards a second launch's link to the running app, macOS `open-url`,
 * and the renderer's "ready" signal. The policy lives in ./deepLinks.
 */

/** The window links act on: the focused app window, else the first one. */
function targetWindow(): BrowserWindow | undefined {
  const focused = BrowserWindow.getFocusedWindow()
  const windows = appWindows()
  return focused && windows.includes(focused) ? focused : windows[0]
}

function send(channel: string, ...args: unknown[]): void {
  const win = targetWindow()
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, ...args)
}

/** A canonical path for an existing directory, else null. */
export function resolveDirectory(path: string): string | null {
  try {
    const real = realpathSync(resolve(path))
    return statSync(real).isDirectory() ? real : null
  } catch {
    return null
  }
}

function canonical(path: string): string {
  return resolveDirectory(path) ?? path
}

/** Whether Houston has opened this folder: a recent folder, or a chat's folder. */
function isKnownFolder(dir: string): boolean {
  if (getSettings().recentWorkspaces.some((p) => canonical(p) === dir)) return true
  return listConversations().some((c) => Boolean(c.workspace) && canonical(c.workspace) === dir)
}

export function wireDeepLinks(opts: {
  /** Startup work (credential store) that must finish before a link reads settings. */
  started: Promise<unknown>
  /** Open the main window when none is open (macOS keeps running with no window). */
  createWindow: () => void
}): DeepLinkRouter {
  const focusWindow = (): void => {
    const win = targetWindow()
    if (!win) {
      if (app.isReady()) opts.createWindow()
      return
    }
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }

  const router = createDeepLinkRouter({
    focusWindow,
    openFolder: (dir) => {
      rememberWorkspace(dir)
      const cmd: MenuCommand = { type: 'new-chat-in-workspace', workspace: dir }
      send(IPC.menuCommand, cmd)
    },
    // A window already showing that chat comes forward; otherwise the target window opens it.
    openChat: (id) => {
      const showing = windowShowing(id)
      if (showing && !showing.isDestroyed()) {
        if (showing.isMinimized()) showing.restore()
        showing.show()
        showing.focus()
        return
      }
      send(IPC.chatOpenRequest, id)
    },
    openSettings: (page) => send(IPC.menuOpenSettings, page),
    resolveDirectory,
    isKnownFolder,
    conversationExists,
    confirmFolder: async (dir) => {
      const win = targetWindow()
      const options = {
        type: 'question' as const,
        buttons: ['Open Folder', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: 'Open this folder in Houston?',
        detail: `${dir}\n\nA link asked Houston to open a folder it hasn't opened before. Open it only if you expected this.`
      }
      const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
      return response === 0
    },
    warn: (message, detail) => {
      const win = targetWindow()
      const options = { type: 'warning' as const, message, ...(detail ? { detail } : {}) }
      void (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options))
    },
    log: (message) => log.info(message)
  })

  // The renderer says when its listeners are attached; until then links are held.
  // A closed window holds them again until the next one is ready (macOS keeps the
  // app running with no window).
  ipcMain.on(IPC.deepLinkReady, (event) => {
    if (!appWindows().some((w) => !w.isDestroyed() && w.webContents === event.sender)) return
    event.sender.once('destroyed', () => {
      if (appWindows().every((w) => w.isDestroyed() || w.webContents === event.sender)) router.markNotReady()
    })
    void opts.started.then(() => router.markReady())
  })

  // macOS delivers links as an event, at launch and while running.
  app.on('open-url', (event, url) => {
    event.preventDefault()
    void router.handle(url)
  })
  // Windows and Linux start a second process with the link on argv; the lock below
  // hands its argv to this one and the second process quits.
  app.on('second-instance', (_event, argv) => {
    const link = deepLinkFromArgv(argv)
    if (link) void router.handle(link)
    else focusWindow()
  })
  const launchLink = deepLinkFromArgv(process.argv)
  if (launchLink) void router.handle(launchLink)

  // Packaged builds register the scheme at install time (electron-builder's
  // `protocols`); this repairs the registration if another install took it over.
  // A development build is never registered, so links keep opening the installed app.
  if (app.isPackaged && !app.isDefaultProtocolClient(DEEP_LINK_SCHEME)) {
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME)
  }
  return router
}
