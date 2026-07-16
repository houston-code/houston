import { Notification, type BrowserWindow } from 'electron'
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
  opts: { enabled: boolean; workspaceName?: string }
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
  })
  n.show()
}
