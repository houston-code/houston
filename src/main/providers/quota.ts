import { AsyncLocalStorage } from 'node:async_hooks'
import type { Provider, ProviderStreamEvent } from '@shared/agent'
import type { ProviderQuota } from '@shared/rateLimit'

/**
 * The rate-limit quota each provider reported on its latest response, success or
 * not. Anthropic and OpenAI-style APIs send `*-ratelimit-*` headers on every reply,
 * but only a 429 used to be read, so nothing could show how close a session was to
 * being throttled until it already was. The clients read this to show the quota
 * left (the TUI status line; the desktop app over IPC).
 *
 * Responses are attributed to a provider by an async context set around each step
 * of its stream ({@link withQuotaScope}), so the shared `fetch` wrapper records them
 * without every adapter threading a provider id through. In-memory, per process.
 */

const scope = new AsyncLocalStorage<string>()
const latest = new Map<string, ProviderQuota>()
const listeners = new Set<(providerId: string, quota: ProviderQuota) => void>()

/** A header as a non-negative whole number, or undefined. */
function count(headers: Headers, names: string[]): number | undefined {
  for (const n of names) {
    const raw = headers.get(n)?.trim()
    if (!raw) continue
    const v = Number(raw)
    if (Number.isFinite(v) && v >= 0) return Math.floor(v)
  }
  return undefined
}

/** The quota a response's headers describe, or null when they carry none. */
export function quotaFromHeaders(headers: Headers, status: number, now: Date = new Date()): ProviderQuota | null {
  const remainingRequests = count(headers, ['anthropic-ratelimit-requests-remaining', 'x-ratelimit-remaining-requests'])
  const remainingTokens = count(headers, [
    'anthropic-ratelimit-tokens-remaining',
    'anthropic-ratelimit-input-tokens-remaining',
    'x-ratelimit-remaining-tokens'
  ])
  const limitRequests = count(headers, ['anthropic-ratelimit-requests-limit', 'x-ratelimit-limit-requests'])
  const limitTokens = count(headers, [
    'anthropic-ratelimit-tokens-limit',
    'anthropic-ratelimit-input-tokens-limit',
    'x-ratelimit-limit-tokens'
  ])
  if (remainingRequests === undefined && remainingTokens === undefined) return null
  return {
    ...(remainingRequests !== undefined ? { remainingRequests } : {}),
    ...(remainingTokens !== undefined ? { remainingTokens } : {}),
    ...(limitRequests !== undefined ? { limitRequests } : {}),
    ...(limitTokens !== undefined ? { limitTokens } : {}),
    ...(status === 429 ? { throttled: true } : {}),
    at: now.toISOString()
  }
}

/**
 * Note a response's quota headers against the provider whose stream is running.
 * Called by the providers' shared fetch wrapper for every response; a response
 * outside any provider scope (a model listing) or without the headers is ignored.
 */
export function recordResponseQuota(headers: Headers | undefined, status: number): void {
  const providerId = scope.getStore()
  if (!providerId || typeof headers?.get !== 'function') return
  const quota = quotaFromHeaders(headers, status)
  if (!quota) return
  latest.set(providerId, quota)
  for (const l of listeners) {
    try {
      l(providerId, quota)
    } catch {
      // A listener's failure must not fail the provider request.
    }
  }
}

/** The latest quota per provider id. */
export function providerQuotas(): Record<string, ProviderQuota> {
  return Object.fromEntries(latest)
}

/** The latest quota a provider reported, if any. */
export function providerQuota(providerId: string): ProviderQuota | undefined {
  return latest.get(providerId)
}

/** Be told whenever a provider reports a new quota. Returns the unsubscribe. */
export function onProviderQuota(listener: (providerId: string, quota: ProviderQuota) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Forget every recorded quota (tests). */
export function resetProviderQuotas(): void {
  latest.clear()
}

/**
 * `provider` with every step of its stream (and the web search it runs) attributed
 * to `providerId`, so the requests they make record their quota under it. Each
 * `next()` runs inside the scope: an async generator's body resumes in the caller's
 * context, so scoping only its creation would not reach the requests.
 */
export function withQuotaScope(providerId: string, provider: Provider): Provider {
  const scoped: Provider = {
    ...provider,
    async *streamChat(req) {
      const it = provider.streamChat(req)
      try {
        for (;;) {
          const r: IteratorResult<ProviderStreamEvent> = await scope.run(providerId, () => it.next())
          if (r.done) return
          yield r.value
        }
      } finally {
        // An abandoned stream (the consumer stopped early) releases the inner one.
        await scope.run(providerId, () => it.return?.(undefined)).catch(() => {})
      }
    }
  }
  if (provider.webSearch) {
    const search = provider.webSearch.bind(provider)
    scoped.webSearch = (req) => scope.run(providerId, () => search(req))
  }
  return scoped
}
