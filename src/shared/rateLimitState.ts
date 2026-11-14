import type { ThrottleInfo } from './rateLimit'

/**
 * The last rate-limit state Houston saw for a provider: how much of its current
 * window was left and when it said it would take requests again. Kept in the main
 * process per provider and shown in the status bar and the Usage view, so the quota a
 * throttle reported doesn't vanish with the retry notice that carried it.
 *
 * Today the only source is a throttled request's retry (`source: 'retry'`). A richer
 * source, such as the rate-limit headers of every response, can record the same
 * shape with its own `source` and replace it: the store keeps whichever is newest.
 */
export interface RateLimitState {
  providerId: string
  /** When this was observed (epoch ms). */
  observedAt: number
  remainingRequests?: number
  remainingTokens?: number
  /** When the provider said capacity comes back (epoch ms), if it said. */
  resetAt?: number
  source: 'retry' | 'headers'
}

/** The state a throttled retry reports, or null when it carried nothing to keep. */
export function stateFromThrottle(providerId: string, t: ThrottleInfo, now: number): RateLimitState | null {
  const resetAt = t.retryAfterMs !== undefined ? now + t.retryAfterMs : undefined
  if (t.remainingRequests === undefined && t.remainingTokens === undefined && resetAt === undefined) return null
  return {
    providerId,
    observedAt: now,
    ...(t.remainingRequests !== undefined ? { remainingRequests: t.remainingRequests } : {}),
    ...(t.remainingTokens !== undefined ? { remainingTokens: t.remainingTokens } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
    source: 'retry'
  }
}

/** "3:42 PM": a clock time as the status bar shows it. */
function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/** "12 requests and 4,000 tokens left": what is left, or '' when neither is known. */
export function remainingText(s: RateLimitState): string {
  const left: string[] = []
  if (s.remainingRequests !== undefined)
    left.push(`${s.remainingRequests.toLocaleString('en-US')} request${s.remainingRequests === 1 ? '' : 's'}`)
  if (s.remainingTokens !== undefined)
    left.push(`${s.remainingTokens.toLocaleString('en-US')} token${s.remainingTokens === 1 ? '' : 's'}`)
  return left.length ? `${left.join(' and ')} left` : ''
}

/** "resets 3:42 PM" while the reset is ahead, '' once it has passed or when unknown. */
export function resetText(s: RateLimitState, now: number): string {
  return s.resetAt !== undefined && s.resetAt > now ? `resets ${clock(s.resetAt)}` : ''
}

/** The whole state in one line, e.g. "12 requests left, resets 3:42 PM (as of 3:41 PM)". */
export function rateLimitLine(s: RateLimitState, now: number): string {
  const parts = [remainingText(s), resetText(s, now)].filter(Boolean)
  const what = parts.length ? parts.join(', ') : 'Rate limited'
  return `${what.charAt(0).toUpperCase()}${what.slice(1)} (as of ${clock(s.observedAt)})`
}
