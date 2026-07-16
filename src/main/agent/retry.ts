/**
 * Transient-failure handling for provider streaming. The SDKs retry the *initial*
 * request a couple of times, but a connection that fails before any output — or a
 * failure after their retries are exhausted — otherwise kills the whole run. The
 * loop retries such failures (only when nothing was streamed yet, so output can't
 * duplicate) with exponential backoff + jitter.
 */

/**
 * Max transient-failure retries for one provider call (so up to this + 1 attempts).
 *
 * Sized against the backoff curve rather than picked round: at 6 the last window is
 * the first to reach {@link backoffDelayMs}'s 15s cap, which puts the worst-case wait
 * near 40s and the typical one near 30s. That's the shape of a provider blip — the
 * previous budget of 3 gave up after ~5.6s, so the cap was unreachable and an overload
 * that cleared in ten seconds still failed the run.
 */
export const MAX_PROVIDER_RETRIES = 6

/**
 * Longest we'll honor a server's `Retry-After`. A provider shedding load can name a
 * window far longer than a run should sit blocked, and a broken one can name an absurd
 * one, so clamp it: we retry early, and if the server still isn't ready it just says so
 * again — the attempt budget bounds the total either way.
 */
const RETRY_AFTER_CAP_MS = 60_000

/**
 * A provider failure that arrived **in-band** (as a stream `error` event) rather than as
 * a thrown SDK error. Carries the status the adapter derived, so {@link isRetryableError}
 * and {@link retryAfterHintMs} classify it exactly like a thrown one. A plain
 * `new Error(ev.message)` drops that, leaving a retryable overload to be judged on its
 * prose — which is how a failed Responses stream came to be permanently fatal.
 */
export class ProviderError extends Error {
  readonly status?: number
  readonly retryAfterMs?: number
  constructor(message: string, opts: { status?: number; retryAfterMs?: number } = {}) {
    super(message)
    this.name = 'ProviderError'
    this.status = opts.status
    this.retryAfterMs = opts.retryAfterMs
  }
}

/** Turn an in-band provider `error` event into a throwable that keeps its status. */
export function providerStreamError(ev: {
  message: string
  status?: number
  retryAfterMs?: number
}): ProviderError {
  return new ProviderError(ev.message, { status: ev.status, retryAfterMs: ev.retryAfterMs })
}

/** Whether an error looks transient and worth retrying. Defaults to NOT retrying. */
export function isRetryableError(err: unknown): boolean {
  const status = (err as { status?: number })?.status
  if (typeof status === 'number') {
    // Retry rate-limits, conflicts, request-timeouts, and any server error.
    return status === 408 || status === 409 || status === 429 || status >= 500
  }
  const msg = String((err as { message?: unknown })?.message ?? err).toLowerCase()
  // The 5xx alternative is anchored to a status/http/code context so a bare 3-digit
  // number in a *permanent* error's text (e.g. "Requested 550 completions") isn't
  // mistaken for a retryable server error. (5xx status codes still go through the
  // numeric `status` branch above; this only covers messages that embed the status.)
  return /overloaded|rate.?limit|too many requests|timeout|timed out|econnreset|etimedout|enotfound|eai_again|socket hang up|network|fetch failed|temporarily|unavailable|connection (error|reset|closed|refused)|stream (closed|error|interrupted)|(?:status|http|code)[^0-9]{0,6}5\d\d\b/.test(
    msg
  )
}

/**
 * Whether a provider error means "this model can't do tool calling at all".
 * The agent is built on tools, so this is fatal (not retryable) — the caller
 * surfaces a friendlier message pointing at a tool-capable model instead of the
 * raw API string. Local servers phrase it distinctively and report it as a 4xx,
 * e.g. Ollama: "<model> does not support tools".
 */
export function isToolsUnsupportedError(err: unknown): boolean {
  const status = (err as { status?: number })?.status
  if (typeof status === 'number' && status !== 400 && status !== 404 && status !== 422) return false
  const msg = String((err as { message?: unknown })?.message ?? err).toLowerCase()
  return /not support tool|tool (?:use|calling|s) (?:is |are )?not supported/.test(msg)
}

/** Exponential backoff with full jitter, in ms. `rand` is injectable for tests. */
export function backoffDelayMs(
  attempt: number,
  opts: { base?: number; cap?: number; rand?: () => number } = {}
): number {
  const base = opts.base ?? 800
  const cap = opts.cap ?? 15_000
  const rand = opts.rand ?? Math.random
  const exp = Math.min(cap, base * 2 ** Math.max(0, attempt - 1))
  return Math.round(exp * (0.5 + rand() * 0.5)) // 50–100% of the window
}

/** Read a header off an SDK error's `headers`, which may be a `Headers` or a plain record. */
function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined
  // Both the Anthropic and OpenAI SDKs expose `headers`, but which of the two shapes
  // you get varies by version, so probe rather than assume. `get` is duck-typed here
  // and could be anything, hence the guard.
  const maybeGet = (headers as { get?: unknown }).get
  if (typeof maybeGet === 'function') {
    try {
      const v = (headers as Headers).get(name)
      return v ?? undefined
    } catch {
      return undefined
    }
  }
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (k.toLowerCase() !== name) continue
    if (typeof v === 'string') return v
    if (Array.isArray(v) && typeof v[0] === 'string') return v[0]
    return undefined
  }
  return undefined
}

/**
 * The wait the server itself asked for, in ms, or undefined when it didn't ask. A 429
 * names the window it wants you back in; guessing instead is how a rate-limit retry
 * lands too early and burns an attempt on a second 429.
 *
 * Handles both `Retry-After` forms (delta-seconds and HTTP-date), and the parsed value
 * an in-band {@link ProviderError} already carries. Clamped to {@link RETRY_AFTER_CAP_MS}.
 */
export function retryAfterHintMs(err: unknown, now: number = Date.now()): number | undefined {
  const e = err as { retryAfterMs?: unknown; headers?: unknown } | null | undefined
  const direct = e?.retryAfterMs
  if (typeof direct === 'number' && Number.isFinite(direct) && direct >= 0) {
    return Math.min(direct, RETRY_AFTER_CAP_MS)
  }
  const raw = headerValue(e?.headers, 'retry-after')?.trim()
  if (!raw) return undefined
  const secs = Number(raw)
  if (Number.isFinite(secs)) return secs <= 0 ? 0 : Math.min(secs * 1000, RETRY_AFTER_CAP_MS)
  const at = Date.parse(raw)
  if (Number.isNaN(at)) return undefined
  return Math.min(Math.max(0, at - now), RETRY_AFTER_CAP_MS)
}

/**
 * How long to wait before the next attempt. Prefers the server's `Retry-After` (it knows
 * its own window; our backoff is a blind guess), but never drops below the jittered
 * backoff — a `Retry-After: 0` from an overloaded server would otherwise turn the retry
 * budget into a hot loop against the thing that's already struggling.
 */
export function retryDelayMs(
  err: unknown,
  attempt: number,
  opts: { base?: number; cap?: number; rand?: () => number; now?: number } = {}
): number {
  const backoff = backoffDelayMs(attempt, opts)
  const hint = retryAfterHintMs(err, opts.now)
  return hint === undefined ? backoff : Math.max(hint, backoff)
}

/**
 * Run a provider call that accumulates its whole result before anyone sees it, retrying
 * transient failures on the same policy as the main turn loop.
 *
 * Safe to retry wholesale *because* nothing is streamed: a failed attempt's partial text
 * is discarded and re-accumulated, so a retry can't duplicate output someone already
 * read. The main turn loop can't use this — it streams as it goes, so it enforces its own
 * `emitted` guard instead. Callers that stream to a user must do the same.
 *
 * `signal` is the caller's own abort (Stop, or a bounding timeout); an abort is never
 * retried, and it cuts a pending backoff short rather than waiting it out.
 */
export async function withProviderRetry<T>(
  attempt: () => Promise<T>,
  opts: {
    signal?: AbortSignal
    maxRetries?: number
    onRetry?: (attempt: number, err: unknown) => void
  } = {}
): Promise<T> {
  const max = opts.maxRetries ?? MAX_PROVIDER_RETRIES
  const signal = opts.signal ?? new AbortController().signal
  for (let n = 0; ; n++) {
    try {
      return await attempt()
    } catch (e) {
      if (signal.aborted || n >= max || !isRetryableError(e)) throw e
      opts.onRetry?.(n + 1, e)
      await abortableSleep(retryDelayMs(e, n + 1), signal)
      // The backoff itself is where a Stop most often lands; don't spend an attempt
      // on a request we'd immediately abandon.
      if (signal.aborted) throw e
    }
  }
}

/** Sleep that resolves early if the signal aborts. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const onAbort = (): void => {
      clearTimeout(t)
      resolve()
    }
    // Remove the listener on the normal timeout path too: `{ once: true }` only drops it
    // when 'abort' actually fires, so without this each completed sleep leaks a listener
    // on the run-scoped signal (retries share one), tripping Node's max-listeners warning.
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
