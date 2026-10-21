import { BrowserWindow } from 'electron'

/**
 * Hidden helper windows: the offscreen captures (view_localhost, render_mockup) and
 * the Mermaid renderer. They are BrowserWindows, so Electron counts them like the
 * app's own window: a lingering one would stop "click the dock icon to reopen" from
 * reopening (it checks for zero windows) and would keep Windows and Linux running
 * after the user closes the app's window (they quit when the last window closes).
 */
const helpers = new WeakSet<BrowserWindow>()

export function markHelperWindow(win: BrowserWindow): void {
  helpers.add(win)
}

/** The app's own windows, without the hidden helpers. */
export function appWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter((w) => !helpers.has(w))
}

/** Close every helper; a capture or render in flight fails cleanly and a later one starts afresh. */
export function destroyHelperWindows(): void {
  for (const w of BrowserWindow.getAllWindows()) if (helpers.has(w) && !w.isDestroyed()) w.destroy()
}
