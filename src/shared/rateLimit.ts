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
}

/** "20s", "1m 30s": a wait as people read it. */
function waitText(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
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
  const asked = t.retryAfterMs !== undefined ? ', as the provider asked' : ''
  return `Rate limited by the provider. Retrying in ${waitText(t.waitMs)}${asked} (${progress}).${quota}`
}
