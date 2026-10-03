import { BrowserWindow, Menu, clipboard, dialog } from 'electron'
import {
  SHARE_BLURB,
  SHARE_MESSAGE,
  SHARE_URL,
  shareEmailUrl,
  type ShareResult,
  type ShareTarget
} from '@shared/share'
import { openExternalSafely } from './safeExternal'
import { log } from './logger'

/**
 * "Share Houston": one click hands the invite (see `@shared/share`) to the OS.
 *
 * macOS gets a small native menu: "Copy invite" first (paste it anywhere), then
 * "Share via", the system share submenu (AirDrop, Messages, Mail, plus any
 * installed app that registers a share extension). Windows and Linux have no share
 * menu Electron can open, so there the click copies the invite to the clipboard
 * and the caller confirms it, offering copy-again and email.
 */

/** Whether this platform gets the native share menu rather than copy-to-clipboard. */
export function usesShareSheet(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin'
}

/** Put the invite on the clipboard. */
export function copyInvite(): void {
  clipboard.writeText(SHARE_MESSAGE)
}

/** The macOS share menu: copy first, then the system share services. */
export function shareMenuTemplate(): Electron.MenuItemConstructorOptions[] {
  return [
    { label: 'Copy invite', click: copyInvite },
    { type: 'separator' },
    {
      label: 'Share via',
      role: 'shareMenu',
      sharingItem: { texts: [SHARE_BLURB], urls: [SHARE_URL] }
    }
  ]
}

/**
 * Share from `win`. On macOS the share menu pops up at `at` (window-relative CSS
 * px; the cursor when omitted). Elsewhere the invite is copied to the clipboard.
 */
export function shareHouston(
  win: BrowserWindow | null,
  at?: { x: number; y: number },
  platform: NodeJS.Platform = process.platform
): ShareResult {
  if (usesShareSheet(platform) && win) {
    const point = at ? { x: Math.round(at.x), y: Math.round(at.y) } : {}
    Menu.buildFromTemplate(shareMenuTemplate()).popup({ window: win, ...point })
    return 'sheet'
  }
  copyInvite()
  return 'copied'
}

/** Run a fixed share action. Any URL is built here from constants, never taken from the renderer. */
export function shareHoustonVia(target: ShareTarget): boolean {
  if (target === 'copy') {
    copyInvite()
    return true
  }
  if (target === 'email') return openExternalSafely(shareEmailUrl())
  log.warn(`Ignored unknown share target: ${String(target)}`)
  return false
}

/**
 * The native menu's "Share Houston…" item. macOS opens the share menu at the
 * cursor; Windows/Linux copy the invite and confirm in a dialog that also offers
 * email, since a menu click has no in-app popover to show.
 */
export async function shareHoustonFromMenu(): Promise<void> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
  if (shareHouston(win) === 'sheet') return
  const options = {
    type: 'info' as const,
    message: 'Invite copied',
    detail: `Paste it anywhere to share Houston, or send it by email.\n\n${SHARE_MESSAGE}`,
    buttons: ['Done', 'Send by email'],
    defaultId: 0,
    cancelId: 0
  }
  const { response } = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options)
  if (response === 1) shareHoustonVia('email')
}
