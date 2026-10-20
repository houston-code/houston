import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { extname, relative } from 'node:path'
import { BrowserWindow, protocol, session, type Session } from 'electron'
import { MAX_FULL_PAGE_HEIGHT, type MockupVariant } from '@shared/mockup'
import { resolveInRoots } from './agent/tools'
import { isSensitivePath } from './agent/sensitive-paths'
import { setMockupBackend, type MockupRender, type MockupRenderInput } from './agent/mockupRender'
import { attachCdp, cdpFullPage, cdpScreenshot, emulateViewport, type Cdp } from './cdp'

/**
 * Electron backend for the `render_mockup` tool: renders a project HTML file in an
 * offscreen window and screenshots it per variant.
 *
 * The page is untrusted (the agent wrote it, possibly steered by injected text), so
 * it gets the narrowest world that still renders a mockup:
 *
 *  - It is served from a private `houston-mockup://<token>/` scheme whose handler
 *    reads only files inside the root holding the mockup (symlink-aware, through
 *    resolveInRoots), and never credential files there (isSensitivePath), so a page
 *    can't pull in `~/.ssh/id_rsa` or the project's `.env` as an iframe or image and
 *    have it land in the screenshot. A token is live only while its render runs.
 *  - Its session is in-memory and separate from the app's, cancels every request on
 *    a network scheme, routes anything that slips past to a proxy that isn't there,
 *    and keeps WebRTC off non-proxied UDP, so no request, beacon, socket, or ICE
 *    candidate leaves the machine. Every response also carries a CSP limiting the
 *    page to its own origin and turning off DNS prefetch.
 *  - Downloads, permissions, new windows, and navigation off the token origin are
 *    all refused, and JavaScript dialogs are dismissed rather than left blocking.
 */

export const MOCKUP_SCHEME = 'houston-mockup'
const PARTITION = 'render-mockup'
/** Per-variant load budget; a page that never finishes loading is captured as it stands. */
const LOAD_TIMEOUT_MS = 15_000
/** Give layout, web fonts, and transitions a beat to settle after load. */
const PAINT_SETTLE_MS = 400
/** Largest single file the scheme serves (a mockup's CSS, font, or image). */
const MAX_SERVED_BYTES = 25 * 1024 * 1024
/** Nothing listens here: anything that tries to use the proxy gets refused. */
const DEAD_PROXY = 'http://127.0.0.1:9'

/**
 * Applied to every response. `'self'` is the token origin, so a mockup can use its
 * own CSS, fonts, images, and scripts (inline ones too: mockups are often one file),
 * while connect-src, form-action, and frame-src keep it from talking to anything else.
 */
export const MOCKUP_CSP = [
  "default-src 'self' data: blob:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:",
  "style-src 'self' 'unsafe-inline' data:",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'self' data: blob:",
  "frame-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "form-action 'none'",
  "base-uri 'self'",
  "object-src 'none'"
].join('; ')

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8'
}

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

export function mockupHeaders(contentType: string): Record<string, string> {
  return {
    'content-type': contentType,
    'content-security-policy': MOCKUP_CSP,
    'x-dns-prefetch-control': 'off',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store'
  }
}

/**
 * Whether the mockup session may make a request. Only the private scheme and
 * in-memory data pass; every scheme that can reach a network or the filesystem
 * directly (http, https, ws, wss, ftp, file) is cancelled.
 */
export function isAllowedMockupRequest(url: string): boolean {
  let scheme: string
  try {
    scheme = new URL(url).protocol.replace(/:$/, '').toLowerCase()
  } catch {
    return false
  }
  return scheme === MOCKUP_SCHEME || scheme === 'data' || scheme === 'blob' || scheme === 'about'
}

/** Live render tokens and the root each one may serve from. */
const roots = new Map<string, string>()

export interface ServedFile {
  status: number
  headers: Record<string, string>
  body: Buffer | string
}

/**
 * Answer one request on the private scheme: the file at the URL's path inside the
 * token's root, or a 404. Never anything outside the root, whatever the path says.
 */
export async function serveMockupRequest(
  url: string,
  rootForToken: (token: string) => string | undefined,
  readFile: (abs: string) => Promise<Buffer> = (abs) => fs.readFile(abs)
): Promise<ServedFile> {
  const notFound: ServedFile = { status: 404, headers: mockupHeaders('text/plain; charset=utf-8'), body: 'Not found' }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return notFound
  }
  if (parsed.protocol !== `${MOCKUP_SCHEME}:`) return notFound
  const root = rootForToken(parsed.hostname)
  if (!root) return notFound
  let rel: string
  try {
    rel = parsed.pathname
      .split('/')
      .filter(Boolean)
      .map((seg) => decodeURIComponent(seg))
      .join('/')
  } catch {
    return notFound
  }
  if (!rel || rel.includes('\0')) return notFound
  // A credential file inside the project (a committed .env, a key fixture) would
  // otherwise render into the screenshot via an iframe or fetch, reaching the model
  // without the prompt a read_file of it raises.
  if (isSensitivePath(rel)) return notFound
  let abs: string
  try {
    abs = resolveInRoots([root], rel)
  } catch {
    return notFound
  }
  let body: Buffer
  try {
    // Judge the file the path really reaches: a harmless-looking name can be a
    // symlink to the project's .env, which resolveInRoots allows (it stays inside).
    const real = await fs.realpath(abs)
    if (isSensitivePath(relative(root, real))) return notFound
    const st = await fs.stat(real)
    if (!st.isFile() || st.size > MAX_SERVED_BYTES) return notFound
    body = await readFile(real)
  } catch {
    return notFound
  }
  return { status: 200, headers: mockupHeaders(contentTypeFor(abs)), body }
}

/** The page URL for a file inside `root`, served under `token`. */
export function mockupUrl(token: string, root: string, file: string, query?: string): string {
  const path = relative(root, file)
    .split(/[\\/]/)
    .map((seg) => encodeURIComponent(seg))
    .join('/')
  return `${MOCKUP_SCHEME}://${token}/${path}${query ?? ''}`
}

/**
 * Register the private scheme. Electron allows this only before the app is ready,
 * so it runs from the shell's startup with the rest of the backend wiring.
 */
function registerScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: MOCKUP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }
  ])
}

let sessionReady: Promise<Session> | null = null

function mockupSession(): Promise<Session> {
  if (!sessionReady) {
    sessionReady = (async () => {
      const ses = session.fromPartition(PARTITION)
      ses.protocol.handle(MOCKUP_SCHEME, async (req) => {
        const served = await serveMockupRequest(req.url, (token) => roots.get(token))
        const body = typeof served.body === 'string' ? served.body : new Uint8Array(served.body)
        return new Response(body, { status: served.status, headers: served.headers })
      })
      ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !isAllowedMockupRequest(details.url) }))
      // Belt and braces for anything the request filter doesn't see: every proxied
      // connection goes to a port nothing listens on, loopback included.
      await ses.setProxy({ mode: 'fixed_servers', proxyRules: DEAD_PROXY, proxyBypassRules: '<-loopback>' })
      ses.on('will-download', (event) => event.preventDefault())
      ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
      ses.setPermissionCheckHandler(() => false)
      return ses
    })()
  }
  return sessionReady
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function consoleLevelName(level: unknown): string {
  if (typeof level === 'string') return level
  return ['debug', 'info', 'warning', 'error'][level as number] ?? 'log'
}

async function renderMockupElectron(input: MockupRenderInput): Promise<MockupRender[]> {
  const ses = await mockupSession()
  const token = randomBytes(16).toString('hex')
  roots.set(token, input.root)
  const origin = `${MOCKUP_SCHEME}://${token}/`
  const first = input.variants[0]
  const win = new BrowserWindow({
    show: false,
    width: first.width,
    height: first.height,
    webPreferences: {
      session: ses,
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: false,
      spellcheck: false
    }
  })
  const wc = win.webContents
  wc.setFrameRate(30)
  wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
  const pin = (event: { preventDefault: () => void }, url: string): void => {
    if (!url.startsWith(origin)) event.preventDefault()
  }
  wc.on('will-navigate', (e, url) => pin(e, url))
  wc.on('will-redirect', (e, url) => pin(e, url))
  wc.on('will-frame-navigate', (e) => {
    if (!isAllowedMockupRequest(e.url)) e.preventDefault()
  })
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))

  let entries: string[] = []
  wc.on('console-message', (eventOrLevel: unknown, level?: unknown, message?: unknown) => {
    const e = eventOrLevel as { level?: unknown; message?: unknown } | undefined
    entries.push(`${consoleLevelName(level ?? e?.level).toUpperCase()}: ${String(message ?? e?.message ?? '')}`)
  })

  const throwIfAborted = (): void => {
    if (input.signal?.aborted) throw new Error('Render was cancelled.')
  }
  // Cancelling the run tears the window down at once, so nothing it was waiting on
  // (a load, a DevTools command) can leave an offscreen window behind.
  const onAbort = (): void => {
    if (!win.isDestroyed()) win.destroy()
  }
  input.signal?.addEventListener('abort', onAbort, { once: true })
  let cdp: Cdp | null = null
  const out: MockupRender[] = []
  try {
    throwIfAborted()
    // The DevTools protocol needs a document to attach to (see cdp.ts).
    await win.loadURL('about:blank')
    const session = attachCdp(wc)
    cdp = session
    // A hidden window has nobody to answer alert/confirm/prompt: dismiss them and
    // note it on the console so the agent sees why.
    session.on((method, params) => {
      if (method !== 'Page.javascriptDialogOpening') return
      entries.push(`LOG: [${String(params.type ?? 'dialog')} dismissed] ${String(params.message ?? '')}`)
      void session.send('Page.handleJavaScriptDialog', { accept: false }).catch(() => {})
    })
    await session.send('Page.enable')
    for (const v of input.variants) {
      throwIfAborted()
      entries = []
      out.push(await renderVariant(win, session, v, mockupUrl(token, input.root, input.file, v.query), () => entries, input.signal))
    }
    return out
  } catch (err) {
    if (input.signal?.aborted) throw new Error('Render was cancelled.', { cause: err })
    throw err
  } finally {
    input.signal?.removeEventListener('abort', onAbort)
    roots.delete(token)
    cdp?.detach()
    if (!win.isDestroyed()) win.destroy()
  }
}

async function renderVariant(
  win: BrowserWindow,
  cdp: Cdp,
  v: MockupVariant,
  url: string,
  consoleNow: () => string[],
  signal: AbortSignal | undefined
): Promise<MockupRender> {
  win.setContentSize(v.width, v.height)
  await emulateViewport(cdp, v)
  const loadError = await new Promise<string | undefined>((resolve, reject) => {
    const wc = win.webContents
    let done = false
    const finish = (err?: string): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      wc.removeListener('did-finish-load', onLoad)
      wc.removeListener('did-fail-load', onFail)
      resolve(err)
    }
    const onLoad = (): void => finish()
    const onFail = (_e: unknown, code: number, desc: string, _url: string, isMainFrame: boolean): void => {
      if (isMainFrame) finish(`${desc || 'load failed'} (${code})`)
    }
    const onAbort = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      reject(new Error('Render was cancelled.'))
    }
    const timer = setTimeout(() => finish(`Page did not finish loading within ${LOAD_TIMEOUT_MS}ms`), LOAD_TIMEOUT_MS)
    signal?.addEventListener('abort', onAbort, { once: true })
    wc.on('did-finish-load', onLoad)
    wc.on('did-fail-load', onFail)
    win.loadURL(url).catch(() => {
      /* reported through did-fail-load or the timeout */
    })
  })
  await sleep(PAINT_SETTLE_MS)

  const shot = v.fullPage
    ? await cdpFullPage(cdp, v.width, v.height, MAX_FULL_PAGE_HEIGHT)
    : { png: await cdpScreenshot(cdp), height: v.height, truncated: false }
  return {
    png: shot.png,
    width: v.width,
    height: shot.height,
    console: consoleNow().slice(0, 100),
    ...(loadError ? { loadError } : {}),
    ...(shot.truncated ? { truncated: true } : {})
  }
}

/** Register the scheme and wire the renderer into the agent. Call once, before app ready. */
export function wireMockupCapture(): void {
  registerScheme()
  setMockupBackend(renderMockupElectron)
}
