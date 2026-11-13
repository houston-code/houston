import { BrowserWindow } from 'electron'
import { WindowRegistry, type RegistryWindow } from './windowRegistry'

/**
 * The app's chat windows (see ./windowRegistry for the policy). Hidden helper windows
 * (captures, the diagram renderer) are never registered here, so nothing below sends
 * them app events or picks them to parent a dialog.
 */

interface Entry extends RegistryWindow {
  win: BrowserWindow
}

const registry = new WindowRegistry<Entry>()
const entries = new WeakMap<BrowserWindow, Entry>()

function entryOf(win: BrowserWindow): Entry | undefined {
  return entries.get(win)
}

function focusedWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow?.() ?? null
}

/** Track a newly created chat window until it closes. */
export function registerAppWindow(win: BrowserWindow): void {
  const entry: Entry = {
    id: win.id,
    webContentsId: win.webContents.id,
    isDestroyed: () => win.isDestroyed(),
    win
  }
  entries.set(win, entry)
  registry.add(entry)
  registry.noteFocus(entry)
  win.on('focus', () => registry.noteFocus(entry))
  win.on('closed', () => registry.remove(entry))
}

/** Every open chat window, oldest first. */
export function chatWindows(): BrowserWindow[] {
  return registry.list().map((e) => e.win)
}

/** The oldest open chat window, the one whose size and position are remembered. */
export function isPrimaryWindow(win: BrowserWindow): boolean {
  const e = entryOf(win)
  return e !== undefined && registry.isPrimary(e)
}

/**
 * Where an app-level action lands: the focused chat window, else the last one used.
 * Before any chat window is registered, the focused window (if any) stands in.
 */
export function targetWindow(): BrowserWindow | undefined {
  const focused = focusedWindow()
  return registry.target(focused ? entryOf(focused) : null)?.win ?? focused ?? undefined
}

/** Whether any chat window has focus (the user is looking at the app). */
export function anyChatWindowFocused(): boolean {
  return chatWindows().some((w) => !w.isDestroyed() && w.isFocused())
}

/** Record the chat a window's renderer reports showing. */
export function setWindowShowing(webContentsId: number, conversationId: string | null): void {
  const e = registry.byWebContentsId(webContentsId)
  if (e) registry.setShowing(e, conversationId)
}

/** The chat window showing this chat (preferring the one in use), if any. */
export function windowShowing(conversationId: string): BrowserWindow | undefined {
  const focused = focusedWindow()
  return registry.windowShowing(conversationId, focused ? entryOf(focused) : null)?.win
}

/** Send one message to every chat window's renderer. */
export function sendToChatWindows(channel: string, ...args: unknown[]): void {
  for (const win of chatWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, ...args)
  }
}
