/**
 * Transient-failure handling for provider streaming. The SDKs retry the *initial*
 * request a couple of times, but a connection that fails before any output — or a
 * failure after their retries are exhausted — otherwise kills the whole run. The
 * loop retries such failures (only when nothing was streamed yet, so output can't
 * duplicate) with exponential backoff + jitter.
 */

/** Whether an error looks transient and worth retrying. Defaults to NOT retrying. */
export function isRetryableError(err: unknown): boolean {
  const status = (err as { status?: number })?.status
  if (typeof status === 'number') {
    // Retry rate-limits, conflicts, request-timeouts, and any server error.
    return status === 408 || status === 409 || status === 429 || status >= 500
  }
  const msg = String((err as { message?: unknown })?.message ?? err).toLowerCase()
  return /overloaded|rate.?limit|too many requests|timeout|timed out|econnreset|etimedout|enotfound|eai_again|socket hang up|network|fetch failed|temporarily|unavailable|connection (error|reset|closed|refused)|stream (closed|error|interrupted)|\b5\d\d\b|\b529\b/.test(
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

/** Sleep that resolves early if the signal aborts. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const t = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        resolve()
      },
      { once: true }
    )
  })
}
