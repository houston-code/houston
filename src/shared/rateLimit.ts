/**
 * What a provider said when it throttled a request, as the clients show it: how long
 * Houston waits before trying again, and how much of the provider's quota is left
 * when its response headers said. Pure, so every client words it the same way.
 */

export interface ThrottleInfo {
  /** How long the loop waits before the next attempt, in ms. */
  waitMs: number
  /** The wait the provider asked for (`Retry-After`), when it named one. */
  retryAfterMs?: number
  /** Requests left in the provider's current window, when its headers said. */
  remainingRequests?: number
  /** Tokens left in the provider's current window, when its headers said. */
  remainingTokens?: number
  /**
   * Set while the run waits out a usage limit until it resets (epoch ms), rather than
   * retrying early: the turn carries on by itself then. `waitMs` is the wait to it.
   */
  resetAt?: number
}

/** "14:05": a reset time as the terminal states it (local time, 24-hour). */
export function resetClock(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** "20s", "1m 30s": a wait as people read it. */
function waitText(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s >= 3600) {
    const m = Math.round((s % 3600) / 60)
    return m === 60 ? `${Math.floor(s / 3600) + 1}h` : `${Math.floor(s / 3600)}h${m ? ` ${m}m` : ''}`
  }
  return `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ''}`
}

/**
 * The notice for a throttled attempt, e.g. "Rate limited by the provider. Retrying in
 * 20s (2/6). 0 requests and 1,200 tokens left in this window."
 */
export function throttleNotice(t: ThrottleInfo, progress: string): string {
  const left: string[] = []
  if (t.remainingRequests !== undefined) left.push(`${t.remainingRequests.toLocaleString('en-US')} requests`)
  if (t.remainingTokens !== undefined) left.push(`${t.remainingTokens.toLocaleString('en-US')} tokens`)
  const quota = left.length ? ` ${left.join(' and ')} left in this window.` : ''
  if (t.resetAt !== undefined) {
    return `Usage limit reached. It resets at ${resetClock(t.resetAt)} (in ${waitText(t.waitMs)}); continuing then (${progress}).${quota}`
  }
  const asked = t.retryAfterMs !== undefined ? ', as the provider asked' : ''
  return `Rate limited by the provider. Retrying in ${waitText(t.waitMs)}${asked} (${progress}).${quota}`
}

/**
 * The rate-limit quota a provider reported on its latest response (success or not),
 * from its `*-ratelimit-*` headers. Kept per provider by the main process and read by
 * the clients to show how close a session is to being throttled.
 */
export interface ProviderQuota {
  /** Requests left in the provider's current window. */
  remainingRequests?: number
  /** Tokens left in the provider's current window. */
  remainingTokens?: number
  /** The window's request allowance, when the provider said. */
  limitRequests?: number
  /** The window's token allowance, when the provider said. */
  limitTokens?: number
  /** The response that reported it was a 429. */
  throttled?: boolean
  /** When the response arrived (ISO 8601). */
  at: string
}

/** "1.2k", "350k", "1.5M": a count as a status line shows it. */
function compact(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

/**
 * A short status-line field for a quota, e.g. "rate 45 req · 12k tok left", or null
 * when it names nothing left to show.
 */
export function quotaStatusText(q: ProviderQuota | undefined): string | null {
  if (!q) return null
  const left: string[] = []
  if (q.remainingRequests !== undefined) left.push(`${compact(q.remainingRequests)} req`)
  if (q.remainingTokens !== undefined) left.push(`${compact(q.remainingTokens)} tok`)
  if (!left.length) return null
  return `rate ${left.join(' · ')} left`
}

/**
 * Whether a quota is running low: under a tenth of the window's allowance on either
 * count, or throttled. Without an allowance to compare to, only a throttle counts.
 */
export function quotaIsLow(q: ProviderQuota | undefined): boolean {
  if (!q) return false
  if (q.throttled) return true
  const low = (left?: number, limit?: number): boolean =>
    left !== undefined && limit !== undefined && limit > 0 && left / limit < 0.1
  return low(q.remainingRequests, q.limitRequests) || low(q.remainingTokens, q.limitTokens)
}
