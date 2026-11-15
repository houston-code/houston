import { AsyncLocalStorage } from 'node:async_hooks'
import type { Provider, ProviderStreamEvent } from '@shared/agent'
import type { ProviderQuota } from '@shared/rateLimit'

/**
 * The rate-limit quota each provider and model reported on its latest response,
 * success or not. Anthropic and OpenAI-style APIs send `*-ratelimit-*` headers on every reply,
 * but only a 429 used to be read, so nothing could show how close a session was to
 * being throttled until it already was. The clients read this to show the quota
 * left (the TUI status line; the desktop app over IPC).
 *
 * Responses are attributed to a provider and the model the request named by an async
 * context set around each step of its stream ({@link withQuotaScope}), so the shared
 * `fetch` wrapper records them without every adapter threading them through. The
 * hosts limit each model separately, so a side request on the small model must not
 * replace the chat model's quota. In-memory, per process.
 */

interface QuotaScope {
  providerId: string
  model: string
}

const scope = new AsyncLocalStorage<QuotaScope>()
/** The latest quota per provider, whichever model reported it. */
const latest = new Map<string, ProviderQuota>()
/** The latest quota per provider and model. */
const latestByModel = new Map<string, ProviderQuota>()
const listeners = new Set<(providerId: string, quota: ProviderQuota, model: string) => void>()

const modelKey = (providerId: string, model: string): string => `${providerId}\n${model}`

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

/**
 * A reset header as epoch ms. The Claude API sends an RFC 3339 time
 * (`2026-11-15T10:00:30Z`); OpenAI-style APIs send how long until it, as a Go-style
 * duration (`1s`, `6m0s`, `1h2m3.5s`, `20ms`). Undefined when it is neither.
 */
export function parseResetHeader(raw: string | null | undefined, now: number): number | undefined {
  const v = raw?.trim()
  if (!v || v.length > 64) return undefined
  if (/^\d{4}-\d{2}-\d{2}T/.test(v)) {
    const t = Date.parse(v)
    return Number.isFinite(t) ? t : undefined
  }
  const unit: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1000, ms: 1 }
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/gy
  let total = 0
  let matched = 0
  for (let m = re.exec(v); m; m = re.exec(v)) {
    total += Number(m[1]) * unit[m[2]]
    matched = re.lastIndex
  }
  if (matched !== v.length || !Number.isFinite(total)) return undefined
  return now + Math.round(total)
}

/**
 * When the provider's window is next full again: the latest of the reset times its
 * headers name (requests and tokens reset separately), or undefined when none.
 */
function resetAtFrom(headers: Headers, now: number): number | undefined {
  let latest: number | undefined
  for (const n of [
    'anthropic-ratelimit-requests-reset',
    'anthropic-ratelimit-tokens-reset',
    'anthropic-ratelimit-input-tokens-reset',
    'anthropic-ratelimit-output-tokens-reset',
    'x-ratelimit-reset-requests',
    'x-ratelimit-reset-tokens'
  ]) {
    const t = parseResetHeader(headers.get(n), now)
    if (t !== undefined && (latest === undefined || t > latest)) latest = t
  }
  return latest
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
  const resetAt = resetAtFrom(headers, now.getTime())
  return {
    ...(remainingRequests !== undefined ? { remainingRequests } : {}),
    ...(remainingTokens !== undefined ? { remainingTokens } : {}),
    ...(limitRequests !== undefined ? { limitRequests } : {}),
    ...(limitTokens !== undefined ? { limitTokens } : {}),
    ...(status === 429 ? { throttled: true } : {}),
    ...(resetAt !== undefined ? { resetAt: new Date(resetAt).toISOString() } : {}),
    at: now.toISOString()
  }
}

/**
 * Note a response's quota headers against the provider whose stream is running.
 * Called by the providers' shared fetch wrapper for every response; a response
 * outside any provider scope (a model listing) or without the headers is ignored.
 */
export function recordResponseQuota(headers: Headers | undefined, status: number): void {
  const current = scope.getStore()
  if (!current || typeof headers?.get !== 'function') return
  const quota = quotaFromHeaders(headers, status)
  if (!quota) return
  const { providerId, model } = current
  latest.set(providerId, quota)
  latestByModel.set(modelKey(providerId, model), quota)
  for (const l of listeners) {
    try {
      l(providerId, quota, model)
    } catch {
      // A listener's failure must not fail the provider request.
    }
  }
}

/** The latest quota per provider id, whichever of its models reported it. */
export function providerQuotas(): Record<string, ProviderQuota> {
  return Object.fromEntries(latest)
}

/**
 * The latest quota a provider reported for `model`, if any; with no model, the latest
 * it reported for any model. Pass the model the chat runs on: the hosts limit each
 * model on its own, so another model's quota says nothing about the chat's.
 */
export function providerQuota(providerId: string, model?: string): ProviderQuota | undefined {
  return model === undefined ? latest.get(providerId) : latestByModel.get(modelKey(providerId, model))
}

/** Be told whenever a provider reports a new quota. Returns the unsubscribe. */
export function onProviderQuota(
  listener: (providerId: string, quota: ProviderQuota, model: string) => void
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Forget every recorded quota (tests). */
export function resetProviderQuotas(): void {
  latest.clear()
  latestByModel.clear()
}

/**
 * `provider` with every step of its stream (and the web search it runs) attributed
 * to `providerId` and the request's model, so the requests they make record their
 * quota under them. Each
 * `next()` runs inside the scope: an async generator's body resumes in the caller's
 * context, so scoping only its creation would not reach the requests.
 */
export function withQuotaScope(providerId: string, provider: Provider): Provider {
  const scoped: Provider = {
    ...provider,
    async *streamChat(req) {
      const it = provider.streamChat(req)
      const at: QuotaScope = { providerId, model: req.model }
      try {
        for (;;) {
          const r: IteratorResult<ProviderStreamEvent> = await scope.run(at, () => it.next())
          if (r.done) return
          yield r.value
        }
      } finally {
        // An abandoned stream (the consumer stopped early) releases the inner one.
        await scope.run(at, () => it.return?.(undefined)).catch(() => {})
      }
    }
  }
  if (provider.webSearch) {
    const search = provider.webSearch.bind(provider)
    scoped.webSearch = (req) => scope.run({ providerId, model: req.model }, () => search(req))
  }
  return scoped
}
