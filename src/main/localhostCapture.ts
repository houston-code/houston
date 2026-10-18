import { BrowserWindow, session, type Session } from 'electron'
import { isLoopbackHost } from './agent/loopback'
import { hardenUntrustedSession } from './hardenedSession'
import {
  setCaptureBackend,
  VIEWPORT,
  type CaptureDeps,
  type CaptureStep,
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
/** Longest a click waits for the navigation it started (a form post, a link). */
const CLICK_NAV_TIMEOUT_MS = 15_000
/** Poll interval while waiting on navigation or a `wait_for` selector. */
const POLL_MS = 100

/**
 * Prepended to every step script. The capture window is hidden, so a native
 * alert/confirm/prompt would block the page with no one to answer it: record the
 * message on the console instead (the model sees it) and answer confirm with OK,
 * since the agent chose to click whatever asked. Idempotent per document.
 */
const DIALOG_GUARD = `if (!window.__houstonDialogs) {
  window.__houstonDialogs = true;
  window.alert = (m) => console.log('[alert] ' + String(m));
  window.confirm = (m) => { console.log('[confirm] ' + String(m) + ' (answered OK)'); return true; };
  window.prompt = (m) => { console.log('[prompt] ' + String(m) + ' (answered cancel)'); return null; };
}`

/**
 * The page-side script for a fill or click step. The selector and value are
 * embedded as JSON string literals so they can't break out of the expression.
 * Returns 'ok' or a reason the step could not run.
 */
export function stepScript(step: Extract<CaptureStep, { action: 'fill' | 'click' }>): string {
  const sel = JSON.stringify(step.selector)
  const find = `let el;
    try { el = document.querySelector(${sel}); } catch { return 'invalid CSS selector'; }
    if (!el) return 'no element matches the selector';
    if (el instanceof HTMLInputElement && el.type === 'file') return 'file inputs are not supported';`
  if (step.action === 'click') {
    return `(() => { ${DIALOG_GUARD}
    ${find}
    el.scrollIntoView({ block: 'center' });
    if (el instanceof HTMLElement) el.click();
    else el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'ok';
  })()`
  }
  return `(() => { ${DIALOG_GUARD}
    ${find}
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) {
      return 'the element is not an input, textarea, or select';
    }
    el.focus();
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
    if (desc && desc.set) desc.set.call(el, ${JSON.stringify(step.value)});
    else el.value = ${JSON.stringify(step.value)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`
}

/**
 * Page-side check for a `wait_for` step: does the selector match a visible
 * element? Returns 'invalid' for a selector the page can't parse, so the step
 * fails at once instead of polling until its timeout.
 */
export function visibleScript(selector: string): string {
  return `(() => {
    let el;
    try { el = document.querySelector(${JSON.stringify(selector)}); } catch { return 'invalid'; }
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  })()`
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

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
    // Subresource egress filter + download block + permission denial. Steps can
    // click links and buttons, so a page must never save a file to the user's disk
    // or gain camera/microphone/location/notifications. Shared with the interactive
    // Preview dock so both untrusted-page surfaces stay locked down identically.
    hardenUntrustedSession(ses)
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
    async runStep(step) {
      try {
        if (step.action === 'wait') {
          await sleep(step.ms)
          return { ok: true }
        }
        if (step.action === 'wait_for') {
          const deadline = Date.now() + step.timeoutMs
          for (;;) {
            try {
              const seen = await wc.executeJavaScript(visibleScript(step.selector), true)
              if (seen === 'invalid') return { ok: false, error: 'invalid CSS selector' }
              if (seen === true) return { ok: true }
            } catch {
              // Evaluation can fail transiently mid-navigation; keep polling until the deadline.
            }
            if (Date.now() >= deadline) {
              return { ok: false, error: `no visible element matched within ${step.timeoutMs}ms` }
            }
            await sleep(POLL_MS)
          }
        }
        const result = (await wc.executeJavaScript(stepScript(step), true)) as string
        if (result !== 'ok') return { ok: false, error: result }
        if (step.action === 'click') {
          // Give a navigation (form post, link) a moment to start, then let it finish.
          await sleep(POLL_MS)
          const deadline = Date.now() + CLICK_NAV_TIMEOUT_MS
          while (wc.isLoading() && Date.now() < deadline) await sleep(POLL_MS)
        }
        await sleep(PAINT_SETTLE_MS)
        return { ok: true }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
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
