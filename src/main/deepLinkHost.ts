import { app, dialog, ipcMain, type BrowserWindow, type WebContents } from 'electron'
import { realpathSync, statSync } from 'node:fs'
import { resolve, win32 } from 'node:path'
import { DEEP_LINK_SCHEME, deepLinkFromArgv } from '@shared/deepLink'
import { IPC } from '@shared/constants'
import type { MenuCommand } from '@shared/types'
import { createDeepLinkRouter, type DeepLinkRouter } from './deepLinks'
import { appWindows } from './helperWindows'
import { guardIpcOn } from './ipcSender'
// Links act on the window app-level actions land on: the focused one, else the last used.
import { targetWindow, windowShowing } from './windows'
import { getSettings, rememberWorkspace } from './store'
import { conversationExists, listConversations } from './conversations'
import { log } from './logger'

/**
 * Electron side of `houston://` links: protocol registration, the single-instance
 * lock that forwards a second launch's link to the running app, macOS `open-url`,
 * and the renderer's "ready" signal. The policy lives in ./deepLinks.
 */

/** The window renderers whose page has its link listeners attached (see wireDeepLinks). */
const readySenders = new Set<WebContents>()

/**
 * Where a link goes: the target window when its page is listening, else another
 * window whose page is (brought forward), else the target window.
 */
function send(channel: string, ...args: unknown[]): void {
  const usable = (w: BrowserWindow | undefined): w is BrowserWindow =>
    w !== undefined && !w.isDestroyed() && !w.webContents.isDestroyed()
  const target = targetWindow()
  let win = usable(target) && readySenders.has(target.webContents) ? target : undefined
  if (!win) {
    win = appWindows().find((w) => usable(w) && readySenders.has(w.webContents))
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  }
  win ??= target
  if (usable(win)) win.webContents.send(channel, ...args)
}

/**
 * Whether `path`, resolved the way Windows resolves it (against this process's current
 * directory), names a share or a device (`\\host\share`, `\\?\UNC\…`, `\\.\pipe\…`).
 * The link parser already refuses every spelling that starts with two separators; this
 * also catches a `/x` path resolved against a current directory that is itself a share.
 */
export function resolvesToNetworkPath(
  path: string,
  platform: NodeJS.Platform = process.platform,
  cwd: string = process.cwd()
): boolean {
  if (platform !== 'win32') return false
  return win32.parse(win32.resolve(cwd, path)).root.startsWith('\\')
}

/**
 * A canonical path for an existing directory, else null. A share or device path is
 * refused before anything touches it: on Windows the realpath and stat alone would
 * connect to the host and offer it the user's NTLM credentials, before the dialog
 * that asks whether to open the folder.
 */
export function resolveDirectory(path: string): string | null {
  if (resolvesToNetworkPath(path)) return null
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

  // Each renderer says when its listeners are attached; links are held while no
  // window's page is listening, and go to a listening one (see send).
  // A closed window stops counting (macOS keeps the app running with no window).
  // A reload stops it counting too: the page that attached the listeners is going
  // away, and the new one says ready again once its own are attached. Each renderer is
  // watched once, however many times its page loads.
  // The sender check (ipcSender.ts: a chat window's main frame showing the app) runs
  // first; the app-window check below stays as its own guard.
  const watched = new WeakSet<WebContents>()
  const notReady = (sender: WebContents): void => {
    readySenders.delete(sender)
    if (readySenders.size === 0) router.markNotReady()
  }
  guardIpcOn((channel, listener) => ipcMain.on(channel, listener))(IPC.deepLinkReady, (event) => {
    const sender = event.sender
    if (!appWindows().some((w) => !w.isDestroyed() && w.webContents === sender)) return
    if (!watched.has(sender)) {
      watched.add(sender)
      sender.once('destroyed', () => notReady(sender))
      sender.on('did-start-navigation', (details) => {
        if (details.isMainFrame && !details.isSameDocument) notReady(sender)
      })
    }
    void opts.started.then(() => {
      if (sender.isDestroyed()) return
      readySenders.add(sender)
      return router.markReady()
    })
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
