import { app, Notification, shell, type BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { IPC } from '@shared/constants'
import { isConversationId } from '@shared/deepLink'
import type { AgentEvent } from '@shared/agent'
import { notificationFor, workspaceLabel, type NotifySpec } from '@shared/notify'
import { targetWindow } from './windows'

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
 * Notifications Houston has shown and the OS may still list, by id. Electron removes
 * a notification from Notification Center once its object is garbage collected, so
 * each is kept here until it is clicked or closed (and its click handler with it).
 * Capped: the oldest are let go first, which only matters for one never acted on.
 */
const live = new Map<string, Notification>()
const MAX_LIVE = 100

function keep(id: string, n: Notification): void {
  live.delete(id)
  live.set(id, n)
  while (live.size > MAX_LIVE) live.delete(live.keys().next().value as string)
  const forget = (): void => {
    if (live.get(id) === n) live.delete(id)
  }
  n.on('close', forget)
  n.on('failed', forget)
}

/** How many notifications are being kept (for tests). */
export function liveNotificationCount(): number {
  return live.size
}

const ID_PREFIX = 'houston-chat:'

/**
 * The id a chat's notification carries, so a click can still find the chat after
 * Houston restarts (the OS keeps the id with the notification). Also the thread a
 * chat's notifications group under in Notification Center.
 */
export function chatNotificationId(conversationId: string, nonce: string = randomUUID()): string {
  return `${ID_PREFIX}${conversationId}:${nonce}`
}

/** The chat a notification id names, or null for any other id. */
export function chatIdFromNotificationId(id: string): string | null {
  if (!id.startsWith(ID_PREFIX)) return null
  const conversationId = id.slice(ID_PREFIX.length).split(':')[0]
  return isConversationId(conversationId) ? conversationId : null
}

/**
 * Bring Houston to the front for a clicked notification. Clicking is the user asking
 * for the app, so on macOS it takes focus outright (a hidden app is unhidden too).
 * The window is raised by the caller (the link router, or the window it was shown for).
 */
function bringHoustonForward(win?: BrowserWindow | null): void {
  if (process.platform === 'darwin') app.focus({ steal: true })
  const w = win && !win.isDestroyed() ? win : targetWindow()
  if (!w || w.isDestroyed()) return
  if (w.isMinimized()) w.restore()
  w.show()
  w.focus()
}

/**
 * Stay on screen until the user acts on it, where the platform lets the app choose
 * (Windows and Linux). macOS takes the same choice from the app's default alert style
 * (NSUserNotificationAlertStyle = alert in Info.plist), which the user can change.
 */
const STAY_ON_SCREEN = { timeoutType: 'never' } as const

/**
 * Opens a chat by id, waiting for a window to be ready (the houston:// link router).
 * Set at startup; without it a click falls back to raising the window it was shown for.
 */
let openChat: ((conversationId: string) => void) | null = null

export function setNotificationChatOpener(fn: ((conversationId: string) => void) | null): void {
  openChat = fn
}

/**
 * Fire a native notification for a notable agent event when Houston isn't focused.
 * No-op when notifications are disabled, the platform can't show them, the window
 * is focused (the user is already watching), or the event isn't notable. Clicking
 * the notification brings the window back to the front and opens its chat.
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
  const chatId = opts.conversationId && isConversationId(opts.conversationId) ? opts.conversationId : undefined
  const id = chatId ? chatNotificationId(chatId) : randomUUID()
  const n = new Notification({
    id,
    ...(chatId ? { groupId: `${ID_PREFIX}${chatId}` } : {}),
    title: spec.title,
    body: spec.body,
    ...STAY_ON_SCREEN
  })
  n.on('click', () => {
    live.delete(id)
    // Land on the chat the notification is about, not whatever was open. The link
    // router raises (or reopens) a window and waits until it can show the chat.
    if (chatId && openChat) {
      if (process.platform === 'darwin') app.focus({ steal: true })
      return openChat(chatId)
    }
    bringHoustonForward(win)
    if (opts.conversationId && win && !win.isDestroyed() && !win.webContents.isDestroyed())
      win.webContents.send(IPC.chatOpenRequest, opts.conversationId)
  })
  keep(id, n)
  n.show()
}

/**
 * Re-arm the notifications an earlier run of Houston left in Notification Center, so
 * clicking one opens its chat instead of only bringing Houston forward. macOS only
 * (Electron reads the delivered notifications back from there); a no-op elsewhere.
 */
export async function restoreNotificationClicks(): Promise<number> {
  if (process.platform !== 'darwin' || typeof Notification.getHistory !== 'function') return 0
  let delivered: Notification[]
  try {
    delivered = await Notification.getHistory()
  } catch {
    return 0
  }
  let armed = 0
  for (const n of delivered) {
    const chatId = chatIdFromNotificationId(n.id)
    if (!chatId || live.has(n.id)) continue
    const id = n.id
    n.on('click', () => {
      live.delete(id)
      if (process.platform === 'darwin') app.focus({ steal: true })
      if (openChat) openChat(chatId)
      else bringHoustonForward()
    })
    keep(id, n)
    armed++
  }
  return armed
}

/**
 * Show a sample notification now, focused window or not, from Settings. On macOS the
 * first notification an app posts is what makes the OS ask for permission, and
 * agent notifications only fire while Houston is in the background, so without this
 * that one-time prompt appears while the user is looking elsewhere. Returns false
 * when the platform can't show notifications at all. A `true` only means Houston
 * handed it to the OS: nothing reports back when the OS has notifications turned off.
 */
export function sendTestNotification(agentNotificationsOn = true): boolean {
  if (!Notification.isSupported()) return false
  const id = randomUUID()
  const n = new Notification({
    id,
    title: 'Houston',
    body: agentNotificationsOn
      ? 'Notifications are working. You’ll see these when the agent needs you.'
      : 'Notifications are working, but agent notifications are off. Turn them on in Settings, Notifications.',
    ...STAY_ON_SCREEN
  })
  n.on('click', () => {
    live.delete(id)
    bringHoustonForward()
  })
  keep(id, n)
  n.show()
  return true
}

/**
 * The identity Windows shows Houston's notifications under: electron-builder.yml's
 * `appId`, which the installer gives the Start menu shortcut. Windows drops a toast
 * from an app identity no shortcut carries, and Electron's default identity isn't this
 * one, so without it no agent notification ever appears on an installed Windows build.
 */
export const APP_USER_MODEL_ID = 'com.houston.app'

/** Name the process by {@link APP_USER_MODEL_ID} on Windows, before any notification. */
export function applyAppUserModelId(
  target: { setAppUserModelId(id: string): void },
  platform: NodeJS.Platform = process.platform
): void {
  if (platform === 'win32') target.setAppUserModelId(APP_USER_MODEL_ID)
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
