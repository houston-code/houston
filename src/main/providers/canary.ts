import type { ProviderStreamEvent } from '@shared/agent'
import { ProviderError, providerStreamError, withProviderRetry } from '../agent/retry'

/**
 * Shared driver for the live provider canaries (`*.integration.test.ts`).
 *
 * The canaries exist to catch a provider *rejecting* the request shape Houston builds
 * (a 400 on a removed param, a 404 on a retired model). A hung connection or a 5xx/429
 * blip says nothing about that, yet it used to red the nightly just the same: one
 * preview model stalling past the 60s test timeout opened an alert issue for a run
 * that had no drift in it. So each probe is:
 *
 *  - bounded per attempt, so a stall fails fast as a retryable 408 instead of eating
 *    the whole test budget, and
 *  - retried on the app's own transient policy ({@link withProviderRetry} /
 *    `isRetryableError`), which never retries a 400/404, so real drift still reds on
 *    the first try.
 */

/** Per-attempt cap. Healthy probes finish in ~1–12s; this leaves headroom for a slow thinking model. */
export const CANARY_ATTEMPT_TIMEOUT_MS = 30_000

/** One retry: enough to ride out a blip, few enough that a real outage still reds the run. */
export const CANARY_MAX_RETRIES = 1

/**
 * vitest timeout for one probe: every attempt at its cap, plus the longest backoff
 * `retryDelayMs` can choose (a clamped 60s `Retry-After`), plus slack.
 */
export const CANARY_TEST_TIMEOUT_MS =
  (CANARY_MAX_RETRIES + 1) * CANARY_ATTEMPT_TIMEOUT_MS + 60_000 + 10_000

export interface CanaryProbeOptions {
  attemptTimeoutMs?: number
  maxRetries?: number
  onRetry?: (attempt: number, err: unknown) => void
}

/**
 * Drive one streamed call to completion, retrying transient failures. Resolves `true`
 * when the stream emitted `done`, `false` when it ended without one (not retried: a
 * stream that closes cleanly but incompletely is a shape problem, not a blip). An
 * in-band `error` event is thrown with its status kept, so it's classified exactly
 * like a thrown SDK error.
 */
export async function runCanaryProbe(
  open: (signal: AbortSignal) => AsyncIterable<ProviderStreamEvent>,
  opts: CanaryProbeOptions = {}
): Promise<boolean> {
  const timeoutMs = opts.attemptTimeoutMs ?? CANARY_ATTEMPT_TIMEOUT_MS
  return withProviderRetry(() => attemptOnce(open, timeoutMs), {
    maxRetries: opts.maxRetries ?? CANARY_MAX_RETRIES,
    onRetry: opts.onRetry
  })
}

async function attemptOnce(
  open: (signal: AbortSignal) => AsyncIterable<ProviderStreamEvent>,
  timeoutMs: number
): Promise<boolean> {
  const ctrl = new AbortController()
  const timedOut = (): ProviderError =>
    new ProviderError(`no response within ${timeoutMs}ms`, { status: 408 })
  let timer: ReturnType<typeof setTimeout> | undefined
  // Race rather than rely on the abort alone: an SDK that ignores the signal mid-stream
  // would otherwise hang the attempt until vitest's own timeout, which isn't retried.
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort()
      reject(timedOut())
    }, timeoutMs)
  })
  const drain = async (): Promise<boolean> => {
    let done = false
    for await (const e of open(ctrl.signal)) {
      if (e.type === 'error') throw providerStreamError(e)
      if (e.type === 'done') done = true
    }
    return done
  }
  const draining = drain()
  // If the deadline wins, `draining` may still reject later (with the abort); that
  // outcome is already reported as the timeout, so don't let it surface as unhandled.
  draining.catch(() => {})
  try {
    return await Promise.race([draining, deadline])
  } catch (e) {
    // The SDKs surface our own abort as a generic "aborted" error, which isn't
    // classified as retryable; report it as the timeout it actually was.
    if (ctrl.signal.aborted) throw timedOut()
    throw e
  } finally {
    clearTimeout(timer)
    // Losing the race leaves `drain` pending; abort so it can't keep a socket open.
    ctrl.abort()
  }
}
