import { Notification, shell, type BrowserWindow } from 'electron'
import { IPC } from '@shared/constants'
import type { AgentEvent } from '@shared/agent'
import { notificationFor, workspaceLabel, type NotifySpec } from '@shared/notify'

/**
 * Native desktop notifications for agent events. We ping the user when a turn
 * finishes, the agent needs them (approval / question / error), or a pull request
 * is opened/merged — *while Houston isn't the focused window* — so they can wander
 * off during a long turn and get pulled back when it matters, without being nagged
 * while they're already watching.
 *
 * The "which events are worth a ping" policy lives in @shared/notify, so the
 * terminal clients signal on exactly the same events (they cannot import this
 * module: the standalone CLI has no Electron). This file is the OS call and the
 * focus gate. Re-exported here so existing callers keep one import.
 */

export { notificationFor, workspaceLabel, type NotifySpec }

/**
 * Fire a native notification for a notable agent event when Houston isn't focused.
 * No-op when notifications are disabled, the platform can't show them, the window
 * is focused (the user is already watching), or the event isn't notable. Clicking
 * the notification brings the window back to the front.
 */
export function notifyAgentEvent(
  e: AgentEvent,
  win: BrowserWindow | null,
  opts: { enabled: boolean; workspaceName?: string; conversationId?: string }
): void {
  if (!opts.enabled || !Notification.isSupported()) return
  // Focused window → the user is already watching; don't interrupt.
  if (win && !win.isDestroyed() && win.isFocused()) return
  const spec = notificationFor(e, opts.workspaceName)
  if (!spec) return
  const n = new Notification({ title: spec.title, body: spec.body })
  n.on('click', () => {
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    // Land on the chat the notification is about, not whatever was open.
    if (opts.conversationId && !win.webContents.isDestroyed())
      win.webContents.send(IPC.chatOpenRequest, opts.conversationId)
  })
  n.show()
}

/**
 * Show a sample notification now, focused window or not, from Settings. On macOS the
 * first notification an app posts is what makes the OS ask for permission, and
 * agent notifications only fire while Houston is in the background, so without this
 * that one-time prompt appears while the user is looking elsewhere. Returns false
 * when the platform can't show notifications at all. A `true` only means Houston
 * handed it to the OS: nothing reports back when the OS has notifications turned off.
 */
export function sendTestNotification(): boolean {
  if (!Notification.isSupported()) return false
  new Notification({
    title: 'Houston',
    body: 'Notifications are working. You’ll see these when the agent needs you.'
  }).show()
  return true
}

/**
 * The OS page where the user allows or blocks Houston's notifications, or null where
 * there is no standard one (Linux desktops each have their own). Fixed URLs only:
 * nothing here comes from the renderer.
 */
export function notificationSettingsUrl(platform: NodeJS.Platform = process.platform): string | null {
  if (platform === 'darwin') return 'x-apple.systempreferences:com.apple.Notifications-Settings.extension'
  if (platform === 'win32') return 'ms-settings:notifications'
  return null
}

/** Open the OS notification settings page. Returns false where there is none. */
export async function openNotificationSettings(): Promise<boolean> {
  const url = notificationSettingsUrl()
  if (!url) return false
  await shell.openExternal(url)
  return true
}
