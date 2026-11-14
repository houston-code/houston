/**
 * A persistent, loopback-only browser page for the agent's `browser_session` tool.
 *
 * view_localhost loads a page fresh on every call, so a flow has to fit in one call's
 * steps and nothing carries over. A browser session keeps one page open for the rest
 * of the run instead: the agent opens a local dev server, acts on it, reads its
 * accessibility tree (with element refs it can act on next), and checks its console
 * and network log, across as many calls as it needs. Cookies, storage, and DOM state
 * persist between calls; the page is closed when the run ends.
 *
 * Safety is view_localhost's, unchanged: the page lives in the same hardened
 * offscreen window (sandboxed, context-isolated, no Node, dialogs and file pickers
 * suppressed), its top frame is pinned to loopback hosts, and its session carries
 * the same subresource guard (private, LAN, and metadata hosts blocked; no downloads;
 * no device permissions). Each browser session gets its own in-memory partition, so
 * its cookies are never shared with view_localhost, another run, or the app. Every
 * call is approved like a view_localhost call (see `browserSessionDestination` in
 * permissions.ts), and everything read back from the page is fenced as untrusted by
 * the tool.
 *
 * Like viewlocalhost.ts this module stays free of `electron`: the Electron shell
 * injects the backend at startup (`localhostCapture.ts`), and tests pass a fake.
 */

import { validateLocalhostUrl } from './loopback'
import {
  CaptureInterrupted,
  LOAD_TIMEOUT_MS,
  PAGE_CALL_TIMEOUT_MS,
  REF_PATTERN,
  VIEWPORT,
  formatConsole,
  formatPageText,
  loadWithDeadline,
  parseSteps,
  refSelector,
  runSteps,
  scrubTypedPasswords,
  withPageDeadline,
  type CaptureSession,
  type CaptureStep,
  type StepResult
} from './viewlocalhost'

/** Cap on the accessibility snapshot returned to the model. */
export const MAX_SNAPSHOT_CHARS = 12_000
/** How many console lines or requests a log read returns by default. */
export const DEFAULT_LOG_LIMIT = 50
/** The most console lines or requests one log read may return. */
export const MAX_LOG_LIMIT = 200

/** One request the page made, as the network log reports it. */
export interface NetworkEntry {
  method: string
  url: string
  /** The HTTP status, absent when the request failed or was blocked before a response. */
  status?: number
  /** Why the request failed (a `net::` error code). */
  error?: string
  /** From the request being sent to its response finishing, when both were seen. */
  durationMs?: number
  /** What the page loaded it as (document, script, xhr, fetch, image, ...). */
  resourceType?: string
}

/** The error a subresource request gets when Houston's network guard cancelled it. */
export const BLOCKED_BY_GUARD = 'net::ERR_BLOCKED_BY_CLIENT'

/**
 * A browser session's page: view_localhost's capture operations plus what a page
 * that stays open needs (an accessibility snapshot, a network log, liveness).
 */
export interface BrowserPage extends CaptureSession {
  /** The page's accessibility tree as indented lines, refs included; null if it can't be read. */
  snapshot(): Promise<string | null>
  /** Requests the page made, oldest first (the backend keeps a bounded number). */
  networkEntries(): NetworkEntry[]
  /** True once the page is gone (destroyed, or its renderer crashed). */
  isClosed(): boolean
}

export interface BrowserBackend {
  open(opts: { width: number; height: number }): Promise<BrowserPage>
}

let browserBackend: BrowserBackend | null = null

/** Wire the real (Electron) browser backend. Call once during startup. */
export function setBrowserBackend(backend: BrowserBackend): void {
  browserBackend = backend
}

/** Test-only: clear the wired backend. */
export function resetBrowserBackend(): void {
  browserBackend = null
}

/**
 * Whether a browser backend is wired. Only the Electron shell wires one, so this is
 * false on the terminal and headless clients and in ACP, where the loop leaves
 * `browser_session` out of the toolset.
 */
export function isBrowserBackendConfigured(): boolean {
  return browserBackend !== null
}

/** The wired backend, or null on a client that has none. */
export function browserBackendOrNull(): BrowserBackend | null {
  return browserBackend
}

/** The message a client without the backend gives for any browser_session call. */
export const BROWSER_UNAVAILABLE =
  'browser_session is not available in this client: it needs the Houston desktop app, which has the offscreen browser it runs in.'

const NO_SESSION =
  'No browser session is open. Call browser_session with action "open" and a localhost URL first.'

/**
 * Validate a call's raw `steps`, accepting a snapshot `ref` ("e12") wherever a step
 * takes a selector. A ref becomes the selector for the element the snapshot marked.
 */
export function parseSessionSteps(raw: unknown): CaptureStep[] {
  if (!Array.isArray(raw)) return parseSteps(raw)
  return parseSteps(
    raw.map((item, i) => {
      if (!item || typeof item !== 'object') return item
      const o = item as Record<string, unknown>
      if (o.ref === undefined || o.ref === null || o.ref === '') return o
      if (typeof o.ref !== 'string' || !REF_PATTERN.test(o.ref)) {
        throw new Error(`steps[${i}].ref must be a ref from a snapshot, like "e12".`)
      }
      if (typeof o.selector === 'string' && o.selector.trim()) {
        throw new Error(`steps[${i}] takes a selector or a ref, not both.`)
      }
      const { ref, ...rest } = o
      return { ...rest, selector: refSelector(ref as string) }
    })
  )
}

/** A log read's `limit`, clamped to 1..MAX_LOG_LIMIT. */
export function logLimit(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_LOG_LIMIT
  return Math.min(Math.max(1, Math.floor(raw)), MAX_LOG_LIMIT)
}

/** The snapshot as returned: typed passwords scrubbed, cut on a line boundary to the cap. */
export function formatSnapshot(raw: string, secrets: readonly string[]): { text: string; truncated: boolean } {
  const text = scrubTypedPasswords(raw, secrets).trimEnd()
  if (text.length <= MAX_SNAPSHOT_CHARS) return { text, truncated: false }
  const cut = text.slice(0, MAX_SNAPSHOT_CHARS)
  const nl = cut.lastIndexOf('\n')
  return { text: nl > 0 ? cut.slice(0, nl) : cut, truncated: true }
}

/** One network log line: `GET 200 http://localhost:3000/api/todos (12ms, fetch)`. */
export function formatNetworkEntry(e: NetworkEntry): string {
  const outcome =
    e.status !== undefined ? String(e.status) : e.error === BLOCKED_BY_GUARD ? 'BLOCKED' : `FAILED ${e.error ?? ''}`.trim()
  const notes = [
    ...(e.durationMs !== undefined ? [`${Math.round(e.durationMs)}ms`] : []),
    ...(e.resourceType ? [e.resourceType] : []),
    ...(e.error === BLOCKED_BY_GUARD ? ["Houston's network guard blocks private and LAN hosts"] : [])
  ]
  return `${e.method} ${outcome} ${e.url}${notes.length ? ` (${notes.join(', ')})` : ''}`
}

/** What a page read reports alongside its result. */
export interface PageState {
  finalUrl: string
  title: string
  /** Visible page text (see formatPageText); absent when it could not be read. */
  pageText?: string
  pageTextTruncated?: boolean
}

export interface OpenResult extends PageState {
  /** True when the URL loaded in the page already open, keeping its cookies. */
  reused: boolean
  loadError?: string
}

export interface ActResult extends PageState {
  steps: StepResult[]
}

export interface SnapshotResult {
  finalUrl: string
  title: string
  png: Buffer
  width: number
  height: number
  tree: string
  treeTruncated: boolean
}

/**
 * One run's browser page. Created lazily by the loop and closed when the run ends;
 * every method that touches the page needs one opened first.
 */
export class BrowserSession {
  private page: BrowserPage | null = null
  private requestedUrl = ''

  constructor(private readonly backend: BrowserBackend) {}

  /** The open page, or null when none is open (or it has gone away). */
  private live(): BrowserPage | null {
    if (this.page && this.page.isClosed()) this.page = null
    return this.page
  }

  private require(): BrowserPage {
    const page = this.live()
    if (!page) throw new Error(NO_SESSION)
    return page
  }

  /** Whether a page is open. */
  isOpen(): boolean {
    return this.live() !== null
  }

  /** The URL the open page is on, or null when none is open. */
  currentUrl(): string | null {
    const page = this.live()
    if (!page) return null
    return page.url() || this.requestedUrl || null
  }

  /**
   * Run one call into the page. A page that stopped answering (or a Stop) can't be
   * trusted to answer the next call either, so the session is closed and the model
   * told to open it again.
   */
  private async guard<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (e) {
      if (e instanceof CaptureInterrupted) {
        this.close()
        throw new Error(`${e.message} The browser session was closed; open it again to continue.`, { cause: e })
      }
      throw e
    }
  }

  private async state(page: BrowserPage, signal?: AbortSignal): Promise<PageState> {
    let raw: string | null = null
    try {
      raw = await withPageDeadline(page.pageText(), PAGE_CALL_TIMEOUT_MS, 'reading the page text', signal)
    } catch (e) {
      // Unreadable text still leaves the rest of the result worth returning; a Stop doesn't.
      if (signal?.aborted) throw e
    }
    const text = raw === null ? undefined : formatPageText(raw, page.typedSecrets())
    return {
      finalUrl: page.url() || this.requestedUrl,
      title: page.title(),
      ...(text ? { pageText: text.text, ...(text.truncated ? { pageTextTruncated: true } : {}) } : {})
    }
  }

  /** Load a loopback URL, in the open page when there is one (keeping its cookies). */
  async open(rawUrl: string, signal?: AbortSignal): Promise<OpenResult> {
    const url = validateLocalhostUrl(rawUrl)
    if (signal?.aborted) throw new Error('Capture was cancelled.')
    let page = this.live()
    const reused = page !== null
    if (!page) {
      page = await this.backend.open({ width: VIEWPORT.width, height: VIEWPORT.height })
      this.page = page
    }
    this.requestedUrl = url.toString()
    const opened = page
    return this.guard(async () => {
      const { loadError } = await loadWithDeadline(opened, url.toString(), LOAD_TIMEOUT_MS, signal)
      return { reused, ...(loadError ? { loadError } : {}), ...(await this.state(opened, signal)) }
    })
  }

  /** Run steps in the open page, stopping at the first failure. */
  async act(steps: CaptureStep[], signal?: AbortSignal): Promise<ActResult> {
    const page = this.require()
    if (!steps.length) throw new Error('act needs at least one step.')
    return this.guard(async () => {
      const results = await runSteps(page, steps, signal)
      // A ref that matches nothing is almost always a stale one: the page re-rendered.
      const explained = results.map((r, i) => {
        const sel = 'selector' in steps[i] ? steps[i].selector : undefined
        return !r.ok && r.error === 'no element matches the selector' && sel?.startsWith('[data-houston-ref=')
          ? { ...r, error: 'no element has this ref any more; take a new snapshot' }
          : r
      })
      return { steps: explained, ...(await this.state(page, signal)) }
    })
  }

  /** The page's accessibility tree with element refs, and a screenshot of the viewport. */
  async snapshot(signal?: AbortSignal): Promise<SnapshotResult> {
    const page = this.require()
    return this.guard(async () => {
      const raw = await withPageDeadline(page.snapshot(), PAGE_CALL_TIMEOUT_MS, 'reading the accessibility tree', signal)
      const png = await withPageDeadline(page.screenshot(), PAGE_CALL_TIMEOUT_MS, 'the screenshot', signal)
      const tree = formatSnapshot(raw ?? '', page.typedSecrets())
      return {
        finalUrl: page.url() || this.requestedUrl,
        title: page.title(),
        png,
        width: VIEWPORT.width,
        height: VIEWPORT.height,
        tree: tree.text,
        treeTruncated: tree.truncated
      }
    })
  }

  /** The page's most recent console lines (typed passwords scrubbed), and how many there are in all. */
  console(limit: number): { lines: string[]; total: number; finalUrl: string } {
    const page = this.require()
    const secrets = page.typedSecrets()
    const entries = page.consoleEntries().filter((e) => e.text.trim().length > 0)
    const recent = entries.slice(-limit).map((e) => ({ ...e, text: scrubTypedPasswords(e.text, secrets) }))
    return { lines: formatConsole(recent), total: entries.length, finalUrl: page.url() || this.requestedUrl }
  }

  /** The page's most recent requests (typed passwords scrubbed from their URLs), and how many there are in all. */
  network(limit: number): { lines: string[]; total: number; finalUrl: string } {
    const page = this.require()
    const secrets = page.typedSecrets()
    const entries = page.networkEntries()
    const lines = entries
      .slice(-limit)
      .map((e) => formatNetworkEntry({ ...e, url: scrubTypedPasswords(e.url, secrets) }))
    return { lines, total: entries.length, finalUrl: page.url() || this.requestedUrl }
  }

  /** Close the page. Returns whether one was open. Safe to call any number of times. */
  close(): boolean {
    const page = this.page
    this.page = null
    if (!page) return false
    try {
      page.close()
    } catch {
      // Already gone.
    }
    return true
  }
}
