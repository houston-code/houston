/**
 * Top-level navigation policy for the main window.
 *
 * The renderer is the single trusted context that holds the privileged
 * `window.api` contextBridge (every IPC handler — agent runs, terminal spawn,
 * secret access, file dialogs). If the main frame is ever navigated away to an
 * attacker-controlled document, that document inherits the same preload and can
 * drive all of those handlers. Electron's `setWindowOpenHandler` only governs
 * *new* windows; a same-frame top-level navigation (a dropped `file://`, a form
 * submit, a stray `location =`) is uncontrolled unless we gate `will-navigate` /
 * `will-redirect`.
 *
 * This is the pure allow/deny decision so it can be unit-tested without Electron;
 * `index.ts` wires it to the main window's `webContents`.
 */

/**
 * Whether `target` is a navigation the main frame is allowed to perform: only its
 * own start document (optionally with a `#hash`/`?query` for in-app routing), or —
 * in development — any same-origin URL on the Vite dev server (HMR navigates
 * within its origin). Everything else (other file paths, remote origins, custom
 * schemes) is denied; the caller routes safe web links to the external browser.
 */
export function isAllowedNavigation(target: string, startUrl: string, devUrl?: string): boolean {
  if (!target || typeof target !== 'string') return false
  if (target === startUrl) return true
  // Same document plus a fragment/query — SPA routing and HMR reloads.
  if (target.startsWith(`${startUrl}#`) || target.startsWith(`${startUrl}?`)) return true
  // Dev server: the renderer is served over http(s) and Vite may navigate within
  // its own origin. Only ever applies when a dev URL is configured (never in prod).
  if (devUrl) {
    try {
      if (new URL(target).origin === new URL(devUrl).origin) return true
    } catch {
      // unparseable target — fall through to deny
    }
  }
  return false
}
