import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, session, type Session } from 'electron'
import { VISUAL_SCHEME } from './schemes'
import { PREFETCH_OFF_META } from './mockupCapture'
import { markHelperWindow } from './helperWindows'

/**
 * Inline visuals in the transcript, main-process side.
 *
 * Mermaid diagrams: Mermaid parses model-written text and builds DOM, and has had
 * XSS advisories, so it never runs in the app's renderer. It runs here in a hidden
 * window on its own locked-down, in-memory session that can load nothing but the
 * bundled mermaid.min.js; the renderer gets back an SVG string and shows it through
 * an <img>, where script can't run.
 *
 * Interactive HTML visuals: the model's document is kept in memory and served at
 * `houston-visual://doc/<id>` to a sandboxed iframe in the chat (no
 * allow-same-origin, so it has no access to the app). Each response carries a CSP
 * that allows only inline script and style and refuses every kind of request, a
 * meta tag turning DNS prefetch off, and a first script that removes WebRTC (which
 * no CSP governs) and reports the document's height to the chat.
 */

const MAX_MERMAID_SOURCE = 50_000
const MAX_MERMAID_SVG = 2 * 1024 * 1024
export const MAX_HTML_VISUAL = 256 * 1024
const MAX_HTML_VISUALS = 128
const MERMAID_TIMEOUT_MS = 5_000
const PARTITION = 'render-visual'
const DEAD_PROXY = 'http://127.0.0.1:9'

export type MermaidResult = { svg: string } | { error: string }

const RUNNER_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'"
].join('; ')

/** The page the Mermaid window loads; `__houstonRender` is called per diagram. */
export const MERMAID_RUNNER = `<!doctype html>${PREFETCH_OFF_META}<meta charset="utf-8"><title>mermaid</title>
<script src="mermaid.min.js"></script>
<script>
let n = 0
window.__houstonRender = async (source, theme) => {
  try {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: theme === 'dark' ? 'dark' : 'default' })
    const { svg } = await mermaid.render('houston-mermaid-' + n++, source)
    return { svg }
  } catch (e) {
    return { error: String((e && e.message) || e) }
  }
}
</script>`

/** CSP for an interactive HTML visual: inline script and style only, no requests of any kind. */
export const HTML_VISUAL_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "base-uri 'none'"
].join('; ')

/**
 * Runs before the model's own script. WebRTC can send data out over ICE without a
 * request any CSP or proxy sees, so its constructors are removed and pinned; with
 * frame-src and worker-src 'none' the page has no fresh realm to recover them from.
 * Then report the document height to the chat so the frame can size to it.
 */
export const HTML_VISUAL_RUNTIME = `<script>(() => {
  for (const k of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCSessionDescription', 'RTCIceCandidate']) {
    try { Object.defineProperty(window, k, { value: undefined, writable: false, configurable: false }) } catch {}
  }
  const report = () => parent.postMessage({ houstonVisual: 'resize', height: Math.ceil(document.documentElement.scrollHeight) }, '*')
  addEventListener('load', report)
  addEventListener('DOMContentLoaded', () => new ResizeObserver(report).observe(document.documentElement))
})()</script>`

/** The served document: doctype kept first, then the prefetch-off meta and the runtime. */
export function htmlVisualDocument(html: string): string {
  const doctype = /^\uFEFF?\s*<!doctype[^>]*>/i.exec(html)
  const at = doctype ? doctype[0].length : 0
  return html.slice(0, at) + PREFETCH_OFF_META + HTML_VISUAL_RUNTIME + html.slice(at)
}

const docs = new Map<string, string>()

/** Keep an HTML visual for its frame to load; returns the id, or null when it's too big. */
export function registerHtmlVisual(html: unknown): string | null {
  if (typeof html !== 'string' || !html || html.length > MAX_HTML_VISUAL) return null
  const id = randomBytes(16).toString('hex')
  docs.set(id, html)
  // Oldest first: drop the least recently registered beyond the cap.
  while (docs.size > MAX_HTML_VISUALS) docs.delete(docs.keys().next().value!)
  return id
}

export interface Served {
  status: number
  headers: Record<string, string>
  body: string
}

function headers(contentType: string, csp: string): Record<string, string> {
  return {
    'content-type': contentType,
    'content-security-policy': csp,
    'x-content-type-options': 'nosniff',
    'x-dns-prefetch-control': 'off',
    'cache-control': 'no-store'
  }
}

/** Answer a request for an HTML visual's document (`houston-visual://doc/<id>`). */
export function serveHtmlVisual(url: string, lookup: (id: string) => string | undefined = (id) => docs.get(id)): Served {
  const notFound: Served = { status: 404, headers: headers('text/plain; charset=utf-8', HTML_VISUAL_CSP), body: 'Not found' }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return notFound
  }
  if (parsed.protocol !== `${VISUAL_SCHEME}:` || parsed.hostname !== 'doc') return notFound
  const id = parsed.pathname.replace(/^\//, '')
  if (!/^[0-9a-f]{32}$/.test(id)) return notFound
  const html = lookup(id)
  if (html === undefined) return notFound
  // Recently loaded documents are the ones on screen: keep them last in eviction order.
  if (docs.get(id) === html) {
    docs.delete(id)
    docs.set(id, html)
  }
  return { status: 200, headers: headers('text/html; charset=utf-8', HTML_VISUAL_CSP), body: htmlVisualDocument(html) }
}

/** Answer a request from the Mermaid window: its runner page and the bundled library, nothing else. */
export function serveMermaidAsset(url: string, mermaidJs: () => string): Served {
  const notFound: Served = { status: 404, headers: headers('text/plain; charset=utf-8', RUNNER_CSP), body: 'Not found' }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return notFound
  }
  if (parsed.protocol !== `${VISUAL_SCHEME}:` || parsed.hostname !== 'mermaid') return notFound
  if (parsed.pathname === '/runner.html') {
    return { status: 200, headers: headers('text/html; charset=utf-8', RUNNER_CSP), body: MERMAID_RUNNER }
  }
  if (parsed.pathname === '/mermaid.min.js') {
    return { status: 200, headers: headers('text/javascript; charset=utf-8', RUNNER_CSP), body: mermaidJs() }
  }
  return notFound
}

/** Only the private scheme and in-memory URLs; anything that reaches a network or a file is refused. */
export function isAllowedVisualRequest(url: string): boolean {
  let scheme: string
  try {
    scheme = new URL(url).protocol.replace(/:$/, '').toLowerCase()
  } catch {
    return false
  }
  return scheme === VISUAL_SCHEME || scheme === 'data' || scheme === 'blob' || scheme === 'about'
}

/** Where an iframe in the chat may navigate: an HTML visual's document, or a blank page. */
export function isAllowedChatFrameUrl(url: string): boolean {
  return url.startsWith(`${VISUAL_SCHEME}://doc/`) || url === 'about:blank' || url === 'about:srcdoc'
}

/** Validate a Mermaid request from the renderer (an IPC boundary). */
export function parseMermaidRequest(source: unknown, theme: unknown): { source: string; theme: 'light' | 'dark' } | null {
  if (typeof source !== 'string' || !source.trim() || source.length > MAX_MERMAID_SOURCE) return null
  return { source, theme: theme === 'dark' ? 'dark' : 'light' }
}

let mermaidJsCache: string | null = null
function mermaidJs(): string {
  // Copied next to the main bundle at build time (electron.vite.config.ts).
  mermaidJsCache ??= readFileSync(join(__dirname, 'vendor', 'mermaid.min.js'), 'utf8')
  return mermaidJsCache
}

let sessionReady: Promise<Session> | null = null
function visualSession(): Promise<Session> {
  sessionReady ??= (async () => {
    const ses = session.fromPartition(PARTITION)
    ses.protocol.handle(VISUAL_SCHEME, (req) => {
      const served = serveMermaidAsset(req.url, mermaidJs)
      return new Response(served.body, { status: served.status, headers: served.headers })
    })
    ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !isAllowedVisualRequest(details.url) }))
    await ses.setProxy({ mode: 'fixed_servers', proxyRules: DEAD_PROXY, proxyBypassRules: '<-loopback>' })
    ses.on('will-download', (event) => event.preventDefault())
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    ses.setPermissionCheckHandler(() => false)
    return ses
  })()
  return sessionReady
}

let runner: Promise<BrowserWindow> | null = null
function mermaidWindow(): Promise<BrowserWindow> {
  runner ??= (async () => {
    const win = new BrowserWindow({
      show: false,
      width: 1200,
      height: 800,
      webPreferences: {
        session: await visualSession(),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false,
        spellcheck: false
      }
    })
    markHelperWindow(win)
    const wc = win.webContents
    wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    wc.on('will-navigate', (e) => e.preventDefault())
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.on('closed', () => {
      runner = null
    })
    await win.loadURL(`${VISUAL_SCHEME}://mermaid/runner.html`)
    return win
  })()
  runner.catch(() => {
    runner = null
  })
  return runner
}

let queue: Promise<unknown> = Promise.resolve()

/** Close the Mermaid window once diagrams stop coming, so it doesn't sit around hidden. */
const IDLE_CLOSE_MS = 30_000
let idleTimer: ReturnType<typeof setTimeout> | undefined
function closeWhenIdle(): void {
  clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    void runner?.then((w) => {
      if (!w.isDestroyed()) w.destroy()
    })
  }, IDLE_CLOSE_MS)
  idleTimer.unref?.()
}

/** Render one Mermaid diagram to SVG, one at a time, each within a time limit. */
export function renderMermaid(source: string, theme: 'light' | 'dark'): Promise<MermaidResult> {
  const job = queue.then(async (): Promise<MermaidResult> => {
    // A render in progress must not have the window closed under it.
    clearTimeout(idleTimer)
    let win: BrowserWindow
    try {
      win = await mermaidWindow()
    } catch (e) {
      return { error: `The diagram renderer did not start: ${(e as Error).message}` }
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<MermaidResult>((resolve) => {
      timer = setTimeout(() => {
        // A wedged diagram takes the window with it; the next render starts a fresh one.
        if (!win.isDestroyed()) win.destroy()
        resolve({ error: `The diagram took longer than ${MERMAID_TIMEOUT_MS / 1000} seconds to render.` })
      }, MERMAID_TIMEOUT_MS)
    })
    const work = win.webContents
      .executeJavaScript(`window.__houstonRender(${JSON.stringify(source)}, ${JSON.stringify(theme)})`, true)
      .then((r: unknown): MermaidResult => {
        const out = r as Partial<{ svg: unknown; error: unknown }> | null
        if (out && typeof out.svg === 'string') {
          return out.svg.length > MAX_MERMAID_SVG ? { error: 'The rendered diagram is too large to show.' } : { svg: out.svg }
        }
        return { error: typeof out?.error === 'string' ? out.error : 'The diagram could not be rendered.' }
      })
      .catch((e: unknown): MermaidResult => ({ error: String((e as Error)?.message ?? e) }))
    try {
      return await Promise.race([work, timeout])
    } finally {
      clearTimeout(timer)
    }
  })
  queue = job.catch(() => {})
  void job.finally(closeWhenIdle)
  return job
}

/** Serve HTML visuals to the chat's frames. Call once the app is ready (it uses the default session). */
export function wireHtmlVisualProtocol(): void {
  session.defaultSession.protocol.handle(VISUAL_SCHEME, (req) => {
    const served = serveHtmlVisual(req.url)
    return new Response(served.body, { status: served.status, headers: served.headers })
  })
}
