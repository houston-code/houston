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

// The loopback host classifier and URL validator are shared with the live Preview
// dock (preview.ts) and the background-shell URL detector; re-export them so this
// module's existing tests (and any importer) keep their stable entry point.
import { isLoopbackHost, isBlockedSubresourceHost, validateLocalhostUrl } from './loopback'

export { isLoopbackHost, isBlockedSubresourceHost, validateLocalhostUrl }

/** Offscreen viewport for the capture (a typical laptop content width). */
export const VIEWPORT = { width: 1280, height: 800 }
/** How long to wait for the page to finish loading before screenshotting anyway. */
const LOAD_TIMEOUT_MS = 30_000
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
 * The Electron-backed capture backend is injected at startup by the shell
 * (`src/main/localhostCapture.ts`) via {@link setCaptureBackend}, so this module —
 * and everything that imports it (the agent loop) — stays free of `electron` and
 * portable to non-Electron hosts. Tests pass `deps` explicitly and never touch it.
 */
let captureBackend: CaptureDeps | null = null

/** Wire the real (Electron) capture backend. Call once during startup, before any capture. */
export function setCaptureBackend(deps: CaptureDeps): void {
  captureBackend = deps
}

/** Test-only: clear the wired backend so a suite can restore an unconfigured state. */
export function resetCaptureBackend(): void {
  captureBackend = null
}

/**
 * Whether a capture backend has been wired. Only the Electron shell wires one
 * (`localhostCapture.ts`), so this is false on the standalone CLI — the loop uses
 * it to drop `view_localhost` from the toolset and system prompt rather than
 * offering a tool that can only fail.
 */
export function isCaptureBackendConfigured(): boolean {
  return captureBackend !== null
}

function requireCaptureBackend(): CaptureDeps {
  if (!captureBackend) {
    throw new Error(
      'Localhost capture backend not configured — call setCaptureBackend() during startup (see localhostCapture.ts).'
    )
  }
  return captureBackend
}

/**
 * Load a loopback URL in an offscreen window, screenshot it (optionally just one
 * element), and collect its console output. The session is always closed, even
 * on error or abort. `deps` defaults to the injected backend; tests pass a fake.
 */
export async function captureLocalhost(
  input: CaptureInput,
  deps: CaptureDeps = requireCaptureBackend()
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
