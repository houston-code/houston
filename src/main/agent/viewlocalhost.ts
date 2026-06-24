/**
 * Screen capture for the agent's `view_localhost` tool — the local-network
 * counterpart to `web_fetch`.
 *
 * Houston's agent can start a dev server (a background run_shell), but it can't
 * *see* the result: web_fetch deliberately refuses loopback/private hosts, so the
 * build → look → iterate loop a coding agent needs for web work is broken. This
 * loads a loopback URL in an offscreen Electron BrowserWindow, screenshots it
 * with `webContents.capturePage()`, and collects the page's console output, so a
 * vision-capable model can look at what it built and fix it directly — no human
 * needed to eyeball the page.
 *
 * Safety: this is still local network egress to a server the agent launched, so
 * the tool is approval-gated exactly like web_fetch. The host allowlist is the
 * *inverse* of web_fetch's, and narrower: only loopback (localhost / 127.0.0.0/8
 * / ::1 / 0.0.0.0) is allowed — never the wider private/LAN ranges or cloud
 * metadata — so it can't be repurposed to reach the user's network. The page is
 * loaded in a sandboxed, context-isolated window with no Node integration, since
 * whatever the dev server serves is untrusted.
 */

import { BrowserWindow } from 'electron'

/** Offscreen viewport for the capture (a typical laptop content width). */
const VIEWPORT = { width: 1280, height: 800 }
/** How long to wait for the page to finish loading before screenshotting anyway. */
const LOAD_TIMEOUT_MS = 30_000
/** Give the offscreen compositor a beat to paint after load before capturing. */
const PAINT_SETTLE_MS = 350
/** Cap on console lines returned, so a chatty page can't flood the transcript. */
const MAX_CONSOLE_LINES = 200

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface ConsoleEntry {
  level: string
  text: string
}

export interface CaptureInput {
  /** A loopback URL to load (validated before any window opens). */
  url: string
  /** Optional CSS selector — capture just that element's bounding box. */
  selector?: string
  /** Cancels the capture (wired to the run's abort signal). */
  signal?: AbortSignal
}

export interface LocalhostCapture {
  /** PNG bytes of the screenshot. The caller enforces the attach size cap. */
  png: Buffer
  /** Page console output during load, oldest first, formatted "LEVEL: text". */
  console: string[]
  title: string
  finalUrl: string
  width: number
  height: number
  /** A non-fatal load problem (HTTP error / load failure / timeout); a screenshot is still captured. */
  loadError?: string
  /** True when a `selector` was given but matched nothing — the full viewport was captured instead. */
  selectorMissed?: boolean
}

/**
 * True for loopback hosts a local dev server binds to — the only hosts
 * view_localhost will load. Deliberately narrower than webfetch's `isPrivateHost`
 * block: 10/8, 172.16/12, 192.168/16 and link-local are NOT loopback and are
 * rejected, so this tool can't reach the LAN or cloud metadata.
 */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '') // strip IPv6 brackets
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  // IPv6 loopback / unspecified (a server bound to "all" is reachable via loopback).
  if (h === '::1' || h === '::' || h === '0:0:0:0:0:0:0:1') return true

  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m) {
    if (m.slice(1).some((p) => Number(p) > 255)) return false
    if (Number(m[1]) === 127) return true // 127.0.0.0/8 loopback
    if (h === '0.0.0.0') return true // unspecified — reaches loopback from the same host
  }
  return false
}

/** Parse + validate a URL for view_localhost; throws on a bad scheme or non-loopback host. */
export function validateLocalhostUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`Invalid URL: ${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Only http and https URLs are allowed (got "${url.protocol}").`)
  }
  if (!isLoopbackHost(url.hostname)) {
    throw new Error(
      `view_localhost only loads loopback addresses (localhost, 127.0.0.1, ::1). Refusing: ${
        url.hostname || raw
      }. Use web_fetch for public URLs.`
    )
  }
  return url
}

/** Format collected console entries into capped "LEVEL: text" lines. */
export function formatConsole(entries: ConsoleEntry[]): string[] {
  const lines = entries
    .filter((e) => e.text.trim().length > 0)
    .map((e) => `${e.level.toUpperCase()}: ${e.text}`)
  if (lines.length <= MAX_CONSOLE_LINES) return lines
  const kept = lines.slice(-MAX_CONSOLE_LINES)
  kept.unshift(`[${lines.length - MAX_CONSOLE_LINES} earlier console line(s) omitted]`)
  return kept
}

/**
 * The capture operations view_localhost needs, abstracted away from Electron so
 * the orchestration below is unit-testable without a real BrowserWindow.
 */
export interface CaptureSession {
  /** Resolves when the page finishes loading; carries a `loadError` for HTTP/load failures. */
  load(url: string): Promise<{ loadError?: string }>
  title(): string
  url(): string
  /** The element's bounding rect, or null if the selector matches nothing. */
  rectForSelector(selector: string): Promise<Rect | null>
  /** Capture the full viewport (no rect) or a sub-rect, as PNG bytes. */
  screenshot(rect?: Rect): Promise<Buffer>
  consoleEntries(): ConsoleEntry[]
  close(): void
}

export interface CaptureDeps {
  open: (opts: { width: number; height: number }) => Promise<CaptureSession>
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Capture was cancelled.')
}

/**
 * Wait for the page to load, but never hang: a page that never fires
 * `did-finish-load` (a long-polling SPA, a wedged server) resolves with a
 * timeout warning so we still screenshot whatever rendered. Rejects only on a
 * hard `loadURL` failure or an abort.
 */
export function loadWithDeadline(
  session: CaptureSession,
  url: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<{ loadError?: string }> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      fn()
    }
    const onAbort = (): void => finish(() => reject(new Error('Capture was cancelled.')))
    const timer = setTimeout(
      () => finish(() => resolve({ loadError: `Page did not finish loading within ${timeoutMs}ms` })),
      timeoutMs
    )
    if (signal) {
      if (signal.aborted) return finish(() => reject(new Error('Capture was cancelled.')))
      signal.addEventListener('abort', onAbort, { once: true })
    }
    session.load(url).then(
      (r) => finish(() => resolve(r)),
      (e) => finish(() => reject(e instanceof Error ? e : new Error(String(e))))
    )
  })
}

/**
 * Load a loopback URL in an offscreen window, screenshot it (optionally just one
 * element), and collect its console output. The session is always closed, even
 * on error or abort. `deps` is injectable for tests.
 */
export async function captureLocalhost(
  input: CaptureInput,
  deps: CaptureDeps = defaultDeps
): Promise<LocalhostCapture> {
  const url = validateLocalhostUrl(input.url)
  throwIfAborted(input.signal)

  const session = await deps.open({ width: VIEWPORT.width, height: VIEWPORT.height })
  try {
    const { loadError } = await loadWithDeadline(session, url.toString(), LOAD_TIMEOUT_MS, input.signal)
    throwIfAborted(input.signal)

    let rect: Rect | undefined
    let selectorMissed = false
    if (input.selector) {
      const found = await session.rectForSelector(input.selector)
      if (found) rect = found
      else selectorMissed = true
    }

    const png = await session.screenshot(rect)
    return {
      png,
      console: formatConsole(session.consoleEntries()),
      title: session.title(),
      finalUrl: session.url() || url.toString(),
      width: rect ? rect.width : VIEWPORT.width,
      height: rect ? rect.height : VIEWPORT.height,
      ...(loadError ? { loadError } : {}),
      ...(selectorMissed ? { selectorMissed: true } : {})
    }
  } finally {
    session.close()
  }
}

// ---- Electron-backed session (the real `open`) ---------------------------

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

async function openElectronWindow(opts: { width: number; height: number }): Promise<CaptureSession> {
  const win = new BrowserWindow({
    show: false,
    width: opts.width,
    height: opts.height,
    webPreferences: {
      // Offscreen rendering so the window never flashes on screen; the page is
      // untrusted, so it's sandboxed, isolated, and has no Node integration.
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
  // Subresources (CDN scripts, fonts) are left alone so pages still render.
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

const defaultDeps: CaptureDeps = { open: openElectronWindow }
