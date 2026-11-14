import type { ThrottleInfo } from '@shared/rateLimit'
import { stateFromThrottle, type RateLimitState } from '@shared/rateLimitState'

/**
 * The newest rate-limit state per provider, for the status bar and the Usage view
 * (see `@shared/rateLimitState`). In memory only: quota windows are minutes long, so
 * a state from before a restart would mislead more than help.
 *
 * Fed today from the throttle a retry reports. Any richer source calls `record` with
 * the same shape; the newest observation for a provider wins.
 */

const latest = new Map<string, RateLimitState>()
const listeners = new Set<(all: RateLimitState[]) => void>()

/** Every provider's newest state, oldest provider first. */
export function rateLimitSnapshot(): RateLimitState[] {
  return [...latest.values()]
}

/** Keep `state` if it is newer than what the provider has, and tell the listeners. */
export function recordRateLimit(state: RateLimitState): void {
  if (!state.providerId) return
  const have = latest.get(state.providerId)
  if (have && have.observedAt > state.observedAt) return
  latest.set(state.providerId, state)
  const all = rateLimitSnapshot()
  for (const fn of listeners) fn(all)
}

/** Record what a throttled retry reported for `providerId`, when it reported anything. */
export function noteThrottle(providerId: string | undefined, t: ThrottleInfo, now = Date.now()): void {
  if (!providerId) return
  const state = stateFromThrottle(providerId, t, now)
  if (state) recordRateLimit(state)
}

/** Follow changes. Returns an unsubscribe fn. */
export function onRateLimitChange(fn: (all: RateLimitState[]) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Tests only: forget everything. */
export function _resetRateLimits(): void {
  latest.clear()
  listeners.clear()
}
