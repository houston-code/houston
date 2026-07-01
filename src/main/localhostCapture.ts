import { BrowserWindow, session, type Session } from 'electron'
import { isBlockedSubresourceHost, isLoopbackHost } from './agent/loopback'
import {
  setCaptureBackend,
  VIEWPORT,
  type CaptureDeps,
  type CaptureSession,
  type ConsoleEntry,
  type Rect
} from './agent/viewlocalhost'

/**
 * Electron-backed `open` factory for the `view_localhost` agent tool — the real
 * offscreen BrowserWindow behind the pure orchestration in `agent/viewlocalhost.ts`.
 *
 * This lives in the shell (not under `agent/`) so the engine's dependency graph
 * stays free of `electron`: the engine imports the orchestration + the
 * `setCaptureBackend` seam; this module supplies the runtime capability and is
 * wired once at startup via {@link wireLocalhostCapture}.
 */

/** Give the offscreen compositor a beat to paint after load before capturing. */
const PAINT_SETTLE_MS = 350

/** Normalize a console-message level (number in old Electron, string in new) to a name. */
function consoleLevelName(level: unknown): string {
  if (typeof level === 'string') return level
  switch (level) {
    case 0:
      return 'debug'
    case 1:
      return 'info'
    case 2:
      return 'warning'
    case 3:
      return 'error'
    default:
      return 'log'
  }
}

/** A self-contained expression returning the selector's bounding rect, or null. */
function selectorRectScript(selector: string): string {
  // The selector is embedded as a JSON string literal so it can't break out of the expression.
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  })()`
}

/** Round a rect to integer pixels and clamp it inside the viewport for capturePage. */
function roundRect(rect: Rect): Rect {
  const x = Math.max(0, Math.floor(rect.x))
  const y = Math.max(0, Math.floor(rect.y))
  return {
    x,
    y,
    width: Math.max(1, Math.min(Math.ceil(rect.width), VIEWPORT.width - x)),
    height: Math.max(1, Math.min(Math.ceil(rect.height), VIEWPORT.height - y))
  }
}

/**
 * In-memory session (isolated from the app's default session, so it can't touch
 * app cookies/cache and its request filter doesn't affect the main window) whose
 * web requests are blocked from reaching private/LAN/metadata hosts. Installed
 * once and reused across captures — the filter is stateless.
 */
const CAPTURE_PARTITION = 'view-localhost-capture'
let captureFilterInstalled = false

function captureSession(): Session {
  const ses = session.fromPartition(CAPTURE_PARTITION)
  if (!captureFilterInstalled) {
    ses.webRequest.onBeforeRequest((details, callback) => {
      let host = ''
      try {
        host = new URL(details.url).hostname
      } catch {
        /* unparseable (data:/blob:/about:) — no network egress, allow */
      }
      callback({ cancel: isBlockedSubresourceHost(host) })
    })
    captureFilterInstalled = true
  }
  return ses
}

async function openElectronWindow(opts: { width: number; height: number }): Promise<CaptureSession> {
  const win = new BrowserWindow({
    show: false,
    width: opts.width,
    height: opts.height,
    webPreferences: {
      // Offscreen rendering so the window never flashes on screen; the page is
      // untrusted, so it's sandboxed, isolated, has no Node integration, and runs
      // in a private session whose requests can't reach private/LAN/metadata hosts.
      session: captureSession(),
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: false
    }
  })
  const wc = win.webContents
  // Offscreen windows only paint into their bitmap when given a frame rate.
  wc.setFrameRate(30)

  // Keep the main frame pinned to loopback. BrowserWindow follows redirects
  // internally, so without this a localhost page could 302 the top-level
  // navigation to a public or internal host (e.g. cloud metadata) and we'd
  // screenshot/report that — the same SSRF that webfetch guards per redirect hop.
  // (Subresources are filtered separately by the capture session above: internal
  // hosts blocked, public CDNs allowed so pages still render.)
  const blockOffHost = (event: { preventDefault: () => void }, navUrl: string): void => {
    let host = ''
    try {
      host = new URL(navUrl).hostname
    } catch {
      /* malformed → treat as off-host and block */
    }
    if (!isLoopbackHost(host)) event.preventDefault()
  }
  wc.on('will-navigate', (e, navUrl) => blockOffHost(e, navUrl))
  wc.on('will-redirect', (e, navUrl) => blockOffHost(e, navUrl))
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))

  const entries: ConsoleEntry[] = []
  // The `console-message` payload shape changed across Electron majors — accept both.
  wc.on('console-message', (eventOrLevel: unknown, level?: unknown, message?: unknown) => {
    const e = eventOrLevel as { level?: unknown; message?: unknown } | undefined
    const lvl = level ?? e?.level
    const txt = message ?? e?.message ?? ''
    entries.push({ level: consoleLevelName(lvl), text: String(txt) })
  })

  return {
    load(url) {
      return new Promise((resolve, reject) => {
        let done = false
        const settle = (r: { loadError?: string }): void => {
          if (done) return
          done = true
          setTimeout(() => resolve(r), PAINT_SETTLE_MS)
        }
        wc.once('did-finish-load', () => settle({}))
        wc.on('did-fail-load', (_e, errorCode, errorDescription, _validatedURL, isMainFrame) => {
          // Only the main frame's failure means the page itself didn't load.
          if (isMainFrame) settle({ loadError: `${errorDescription || 'load failed'} (${errorCode})` })
        })
        win.loadURL(url).catch((err) => {
          if (!done) {
            done = true
            reject(err instanceof Error ? err : new Error(String(err)))
          }
        })
      })
    },
    title: () => win.getTitle(),
    url: () => wc.getURL(),
    async rectForSelector(selector) {
      try {
        const rect = (await wc.executeJavaScript(selectorRectScript(selector), true)) as Rect | null
        return rect && rect.width > 0 && rect.height > 0 ? rect : null
      } catch {
        return null
      }
    },
    async screenshot(rect) {
      const image = rect ? await wc.capturePage(roundRect(rect)) : await wc.capturePage()
      return image.toPNG()
    },
    consoleEntries: () => entries,
    close: () => {
      if (!win.isDestroyed()) win.destroy()
    }
  }
}

const electronCaptureDeps: CaptureDeps = { open: openElectronWindow }

/** Bind the agent's `view_localhost` tool to the real Electron capture backend. Call once at startup. */
export function wireLocalhostCapture(): void {
  setCaptureBackend(electronCaptureDeps)
}
