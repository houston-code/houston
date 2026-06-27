import { Menu, BrowserWindow } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { APP_NAME, IPC } from '@shared/constants'
import { checkForUpdatesFromMenu } from './updater'

/**
 * The application menu. Houston previously relied on Electron's default menu,
 * whose File → "Close Window" (⌘W) always closed the whole window. We replace
 * that one item so ⌘W closes the active *terminal tab* when the integrated
 * terminal is focused (the behaviour every editor/terminal has), and only closes
 * the window otherwise. Every other entry keeps its standard role.
 *
 * On macOS the app submenu is built explicitly (rather than the `appMenu` role)
 * so it carries native "Settings…" (⌘,) and "Check for Updates…" items — the
 * former opens the in-app Settings modal over IPC, the latter runs the same feed
 * check as the in-Settings button. Both render on every macOS architecture; there
 * is no arch-specific gating.
 */

/** Whether the integrated terminal currently holds focus in the renderer. The
 * renderer reports this over IPC; the ⌘W handler reads it. */
let terminalFocused = false

export function setTerminalFocused(focused: boolean): void {
  terminalFocused = focused
}

export function isTerminalFocused(): boolean {
  return terminalFocused
}

/** Pure decision for ⌘W, split out so it can be unit-tested without Electron. */
export function resolveCloseAction(focused: boolean): 'close-tab' | 'close-window' {
  return focused ? 'close-tab' : 'close-window'
}

function onCloseShortcut(): void {
  const win = BrowserWindow.getFocusedWindow()
  if (!win) return
  if (resolveCloseAction(terminalFocused) === 'close-tab') {
    win.webContents.send(IPC.terminalCloseActive)
  } else {
    win.close()
  }
}

/** Ask the renderer to open the Settings modal (native menu → in-app UI). */
function onOpenSettings(): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  win?.webContents.send(IPC.menuOpenSettings)
}

/**
 * The macOS app submenu, built by hand so it carries Settings… and Check for
 * Updates… alongside the standard roles. On macOS the first menu's label is always
 * the app name regardless of what we pass, but a label is required by the type.
 */
function macAppMenu(): MenuItemConstructorOptions {
  return {
    label: APP_NAME,
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: onOpenSettings },
      { label: 'Check for Updates…', click: () => void checkForUpdatesFromMenu() },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' }
    ]
  }
}

export function buildAppMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [macAppMenu()] : []),
    {
      label: 'File',
      submenu: [
        // Custom Close: terminal-tab-aware (see onCloseShortcut). Replaces the
        // default role:'close' / role:'quit' item that owned ⌘W.
        { label: 'Close', accelerator: 'CmdOrCtrl+W', click: onCloseShortcut },
        ...(isMac ? [] : [{ role: 'quit' as const }])
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' as const },
        { role: 'zoom' as const },
        ...(isMac
          ? [{ type: 'separator' as const }, { role: 'front' as const }]
          : [{ role: 'close' as const }])
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
