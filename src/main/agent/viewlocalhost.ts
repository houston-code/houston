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

/** Most interaction steps one call may run (a login or a form is a handful). */
export const MAX_STEPS = 20
/** Wall-clock budget for all of a call's steps, after the page has loaded. */
export const STEPS_BUDGET_MS = 60_000
/** Longest a single `wait` step may pause. */
export const MAX_WAIT_MS = 5_000
/** Longest a `wait_for` step may wait for its selector (also its default). */
export const MAX_WAIT_FOR_MS = 10_000
const MAX_SELECTOR_CHARS = 500
const MAX_VALUE_CHARS = 10_000

/**
 * One interaction run in the page before the screenshot, so the agent can
 * exercise a flow (log in, fill and submit a form) instead of only looking at a
 * page. `fill` sets a field's value the way typing would (input and change
 * events, so framework-controlled inputs see it); `click` clicks the element and
 * waits for any navigation it starts; `wait_for` waits until a selector matches
 * a visible element; `wait` pauses.
 */
export type CaptureStep =
  | { action: 'fill'; selector: string; value: string }
  | { action: 'click'; selector: string }
  | { action: 'wait_for'; selector: string; timeoutMs: number }
  | { action: 'wait'; ms: number }

export interface StepResult {
  /** The step, described without any filled value (see {@link describeStep}). */
  step: string
  ok: boolean
  /** Why the step failed (e.g. no element matched). */
  error?: string
}

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
  /** Interactions to run after the page loads and before the screenshot. */
  steps?: CaptureStep[]
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
  /** One entry per step that ran, in order; stops after the first failure. */
  steps?: StepResult[]
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
  /** Run one interaction step in the loaded page. Never throws for a page-level failure. */
  runStep(step: CaptureStep): Promise<{ ok: true } | { ok: false; error: string }>
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

    const steps = input.steps?.length ? await runSteps(session, input.steps, input.signal) : undefined

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
      ...(selectorMissed ? { selectorMissed: true } : {}),
      ...(steps ? { steps } : {})
    }
  } finally {
    session.close()
  }
}

/** A step as shown to the user and the model. Never includes a filled value. */
export function describeStep(step: CaptureStep): string {
  switch (step.action) {
    case 'fill':
      return `fill ${JSON.stringify(step.selector)}`
    case 'click':
      return `click ${JSON.stringify(step.selector)}`
    case 'wait_for':
      return `wait for ${JSON.stringify(step.selector)}`
    case 'wait':
      return `wait ${step.ms}ms`
  }
}

/**
 * Validate the model's raw `steps` argument into typed steps, throwing a message
 * the model can act on. Selectors and values are bounded; waits are clamped to
 * their caps rather than refused, since a too-long wait is a harmless mistake.
 */
export function parseSteps(raw: unknown): CaptureStep[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new Error('steps must be an array.')
  if (raw.length > MAX_STEPS) throw new Error(`steps allows at most ${MAX_STEPS} entries.`)
  return raw.map((item, i): CaptureStep => {
    const where = `steps[${i}]`
    if (!item || typeof item !== 'object') throw new Error(`${where} must be an object.`)
    const o = item as Record<string, unknown>
    const selector = (): string => {
      if (typeof o.selector !== 'string' || !o.selector.trim()) {
        throw new Error(`${where}.selector is required for "${String(o.action)}".`)
      }
      if (o.selector.length > MAX_SELECTOR_CHARS) {
        throw new Error(`${where}.selector is longer than ${MAX_SELECTOR_CHARS} characters.`)
      }
      return o.selector
    }
    const ms = (v: unknown, max: number, dflt: number): number =>
      typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(0, Math.floor(v)), max) : dflt
    switch (o.action) {
      case 'fill': {
        if (typeof o.value !== 'string') throw new Error(`${where}.value is required for "fill".`)
        if (o.value.length > MAX_VALUE_CHARS) {
          throw new Error(`${where}.value is longer than ${MAX_VALUE_CHARS} characters.`)
        }
        return { action: 'fill', selector: selector(), value: o.value }
      }
      case 'click':
        return { action: 'click', selector: selector() }
      case 'wait_for':
        return {
          action: 'wait_for',
          selector: selector(),
          timeoutMs: ms(o.timeout_ms, MAX_WAIT_FOR_MS, MAX_WAIT_FOR_MS)
        }
      case 'wait':
        return { action: 'wait', ms: ms(o.ms, MAX_WAIT_MS, 500) }
      default:
        throw new Error(`${where}.action must be one of fill, click, wait_for, wait.`)
    }
  })
}

/**
 * Run steps in order, stopping at the first failure (later steps would act on a
 * page in an unexpected state) or when the overall budget runs out. The capture
 * still takes its screenshot afterwards, so the model sees where the flow stopped.
 */
export async function runSteps(
  session: CaptureSession,
  steps: CaptureStep[],
  signal?: AbortSignal,
  budgetMs: number = STEPS_BUDGET_MS,
  now: () => number = Date.now
): Promise<StepResult[]> {
  const results: StepResult[] = []
  const deadline = now() + budgetMs
  for (const step of steps) {
    throwIfAborted(signal)
    const label = describeStep(step)
    if (now() > deadline) {
      results.push({ step: label, ok: false, error: `step budget of ${budgetMs / 1000}s used up` })
      break
    }
    let outcome: { ok: true } | { ok: false; error: string }
    try {
      outcome = await session.runStep(step)
    } catch (e) {
      outcome = { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    results.push(outcome.ok ? { step: label, ok: true } : { step: label, ok: false, error: outcome.error })
    if (!outcome.ok) break
  }
  return results
}
