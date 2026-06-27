import { Menu, BrowserWindow } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { IPC } from '@shared/constants'

/**
 * The application menu. Houston previously relied on Electron's default menu,
 * whose File → "Close Window" (⌘W) always closed the whole window. We replace
 * that one item so ⌘W closes the active *terminal tab* when the integrated
 * terminal is focused (the behaviour every editor/terminal has), and only closes
 * the window otherwise. Every other entry keeps its standard role.
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

export function buildAppMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
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
