import { causeFromMessage, type TurnErrorCause } from '@shared/turnError'
import type { ThrottleInfo } from '@shared/rateLimit'
import { STREAM_IDLE_TIMEOUT_MS, streamIdleWindowOf } from '../providers/idle-fetch'

/**
 * Transient-failure handling for provider streaming. This is the only retry layer: the
 * SDK clients are built with {@link SDK_MAX_RETRIES} so a failure reaches it on the first
 * request. The loop retries such failures with exponential backoff + jitter; one that
 * arrives after part of the turn has streamed discards that partial turn first (see
 * `turn_discarded`), so the redo can't duplicate output the user already saw.
 */

/**
 * `maxRetries` for every provider SDK client. Each SDK otherwise retries 408/409/429/5xx
 * and connection errors twice on its own, out of sight: the user saw a silent spinner
 * instead of a `retry` event, a 503 cost three requests per attempt here, an exhausted
 * quota was only recognized after the SDK's retries, and the Anthropic SDK (which the
 * Bedrock, Vertex and Foundry clients extend) slept out any `retry-after` uncapped, so a
 * `retry-after: 3600` parked a turn for an hour past {@link RETRY_AFTER_CAP_MS}.
 */
export const SDK_MAX_RETRIES = 0

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
 * How long a run keeps retrying once the network itself is gone, in place of the
 * attempt count. {@link MAX_PROVIDER_RETRIES} is sized for a provider blip (about 40s),
 * and that's far too short for a dropped Wi-Fi or a train tunnel: every attempt fails
 * fast on DNS or connect, so the budget burned out while the user was still waiting for
 * the network to come back. Only granted once the provider has answered in this run
 * (see {@link RetryBudget}), so a mistyped base URL still fails at the attempt count.
 */
export const NETWORK_OUTAGE_BUDGET_MS = 5 * 60_000

/**
 * Retries for a stream that went quiet past an extended idle window (a reasoning request
 * on Chat Completions, or a local model server; see `withStreamIdleWindow`). Silence that
 * long is a host that stopped, not a network blip, and every retry re-sends and re-bills
 * the whole request and waits out the window again, so one retry is all it gets rather
 * than riding the outage budget or the attempt count.
 */
export const MAX_EXTENDED_IDLE_RETRIES = 1

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

/** Longest root-cause detail appended to a provider error's message. */
const CAUSE_DETAIL_MAX = 200

/**
 * A provider error's message, with the underlying network cause appended when the
 * SDK's own message hides it. A failed request surfaces from the SDKs as a bare
 * "Connection error." (or undici's "fetch failed"), which reads the same whether DNS
 * failed, the connection was refused, or TLS verification rejected a re-signing
 * proxy's certificate. The real reason sits at the bottom of the `cause` chain, so walk
 * it and append its code and message: "Connection error. (unable to get local issuer
 * certificate, UNABLE_TO_GET_ISSUER_CERT_LOCALLY)". Errors with no cause, or whose
 * cause adds nothing the message doesn't already say, come back unchanged.
 */
export function describeProviderError(err: unknown): string {
  const message = String((err as { message?: unknown })?.message ?? err)
  let root: unknown = (err as { cause?: unknown })?.cause
  // Bounded walk: a cause chain can be cyclic.
  for (let i = 0; i < 8; i++) {
    const next = (root as { cause?: unknown })?.cause
    if (next === undefined || next === null || next === root) break
    root = next
  }
  if (root === undefined || root === null) return message
  const causeMessage = String((root as { message?: unknown })?.message ?? root).trim()
  const code = (root as { code?: unknown })?.code
  const codeText = typeof code === 'string' && !causeMessage.includes(code) ? code : ''
  const parts = [causeMessage, codeText]
    // Control characters stripped: this lands in the UI and the terminal.
    // eslint-disable-next-line no-control-regex
    .map((p) => p.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim())
    .filter((p) => p && p !== 'fetch failed' && !message.includes(p))
  if (!parts.length) return message
  const detail = parts.join(', ')
  return `${message} (${detail.length > CAUSE_DETAIL_MAX ? `${detail.slice(0, CAUSE_DETAIL_MAX - 1)}\u2026` : detail})`
}

/**
 * Whether a provider error says the account has run out of quota or credit. OpenAI
 * reports an exhausted balance as a 429 with code `insufficient_quota`, the same
 * status as a rate limit, but no amount of waiting fixes it: retrying only held the
 * error back for the whole backoff budget (about 40 seconds) before showing it.
 *
 * Gemini words every quota that way ("You exceeded your current quota"), its per-minute
 * rate limits included, so its message alone can't decide. A Gemini quota is exhausted
 * only when its `QuotaFailure` names a per-day (or longer) quota, or when it names no
 * wait at all; a per-minute one with a `RetryInfo` delay is a rate limit, retried after
 * that delay (see {@link retryAfterHintMs}).
 */
export function isQuotaExhaustedError(err: unknown): boolean {
  const code = (err as { code?: unknown; error?: { code?: unknown } })?.code ??
    (err as { error?: { code?: unknown } })?.error?.code
  if (code === 'insufficient_quota') return true
  const msg = String((err as { message?: unknown })?.message ?? err)
  if (/insufficient_quota/i.test(msg)) return true
  if (hasLongWindowQuotaFailure(err)) return true
  if (!/exceeded your current quota/i.test(msg)) return false
  return googleRetryDelayMs(err) === undefined
}

/** Longest error message parsed for the JSON body a Gemini error carries. */
const ERROR_JSON_MAX = 64_000

/**
 * The `google.rpc` details of a Gemini error (`QuotaFailure`, `RetryInfo`, ...), or []
 * when it has none. The Gemini SDK throws an `ApiError` whose message is the response
 * body serialized as JSON, so the details are read back out of it; an error object that
 * carries the body's `error` already parsed is read directly.
 */
function googleErrorDetails(err: unknown): Record<string, unknown>[] {
  const detailsOf = (body: unknown): Record<string, unknown>[] | undefined => {
    const first: unknown = Array.isArray(body) ? body[0] : body
    const inner = (first as { error?: unknown } | null | undefined)?.error ?? first
    const details = (inner as { details?: unknown } | null | undefined)?.details
    if (!Array.isArray(details)) return undefined
    return details.filter((d): d is Record<string, unknown> => !!d && typeof d === 'object')
  }
  const direct = detailsOf((err as { error?: unknown } | null | undefined)?.error)
  if (direct) return direct
  const msg = (err as { message?: unknown } | null | undefined)?.message
  if (typeof msg !== 'string' || msg.length > ERROR_JSON_MAX) return []
  const start = msg.search(/[[{]/)
  if (start < 0) return []
  try {
    return detailsOf(JSON.parse(msg.slice(start))) ?? []
  } catch {
    return []
  }
}

const detailType = (d: Record<string, unknown>): string => String(d['@type'] ?? '')

/**
 * A Google quota id that names a window of a day or longer
 * (`GenerateRequestsPerDayPerProjectPerModel-FreeTier`), as opposed to a per-minute one.
 */
const LONG_QUOTA_WINDOW = /per ?(day|week|month|year)|daily|weekly|monthly|yearly/i

/** Whether a Gemini error's `QuotaFailure` names a quota that resets a day or more out. */
function hasLongWindowQuotaFailure(err: unknown): boolean {
  return googleErrorDetails(err).some((d) => {
    if (!detailType(d).endsWith('google.rpc.QuotaFailure')) return false
    const violations: unknown[] = Array.isArray(d.violations) ? d.violations : []
    return violations.some((v) => {
      const quotaId = (v as { quotaId?: unknown } | null)?.quotaId
      return typeof quotaId === 'string' && LONG_QUOTA_WINDOW.test(quotaId)
    })
  })
}

/** A protobuf Duration as JSON (`"41s"`, `"0.5s"`) or as `{ seconds, nanos }`, in ms. */
function durationMs(v: unknown): number | undefined {
  if (typeof v === 'string') {
    const m = /^\s*(\d+(?:\.\d+)?)s\s*$/.exec(v)
    return m ? Number(m[1]) * 1000 : undefined
  }
  if (v && typeof v === 'object') {
    const ms = Number((v as { seconds?: unknown }).seconds ?? 0) * 1000 +
      Number((v as { nanos?: unknown }).nanos ?? 0) / 1e6
    return Number.isFinite(ms) && ms >= 0 ? ms : undefined
  }
  return undefined
}

/**
 * The wait a Gemini error names, in ms (uncapped): its `RetryInfo.retryDelay`, or the
 * "Please retry in 41.18s." sentence its message ends with when the detail is missing.
 */
function googleRetryDelayMs(err: unknown): number | undefined {
  for (const d of googleErrorDetails(err)) {
    if (!detailType(d).endsWith('google.rpc.RetryInfo')) continue
    const ms = durationMs(d.retryDelay)
    if (ms !== undefined) return ms
  }
  const msg = String((err as { message?: unknown } | null | undefined)?.message ?? '')
  const m = /please retry in (\d+(?:\.\d+)?) ?(ms|s)\b/i.exec(msg)
  if (!m) return undefined
  return m[2].toLowerCase() === 'ms' ? Number(m[1]) : Number(m[1]) * 1000
}

/**
 * Error codes that mean the network let us down, not the request: the connection was
 * reset or refused, a lookup failed, or a socket went quiet past its timeout. Checked
 * anywhere on the `cause` chain, because that is where they live. A connection that
 * drops mid-stream surfaces from fetch as a bare `TypeError: terminated` (which the
 * Anthropic SDK rewraps as an `AnthropicError` of the same message); only its cause,
 * an undici `SocketError` with `UND_ERR_SOCKET`, says what happened.
 */
const TRANSIENT_NETWORK_CODES = new Set([
  'UND_ERR_SOCKET',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'EAI_AGAIN',
  'ENOTFOUND',
  // Raised by the providers' idle-timeout fetch (providers/idle-fetch.ts) when a
  // stream stops delivering bytes: the half-open socket a network switch leaves.
  'HOUSTON_STREAM_IDLE'
])

/** Whether the error or anything on its `cause` chain carries a transient network code. */
function hasTransientNetworkCode(err: unknown): boolean {
  let e: unknown = err
  // Bounded walk: a cause chain can be cyclic.
  for (let i = 0; i < 8 && e !== undefined && e !== null; i++) {
    const code = (e as { code?: unknown }).code
    if (typeof code === 'string' && TRANSIENT_NETWORK_CODES.has(code)) return true
    const next = (e as { cause?: unknown }).cause
    if (next === e) break
    e = next
  }
  return false
}

/** Whether an error looks transient and worth retrying. Defaults to NOT retrying. */
export function isRetryableError(err: unknown): boolean {
  if (isQuotaExhaustedError(err)) return false
  const status = (err as { status?: number })?.status
  if (typeof status === 'number') {
    // Retry rate-limits, conflicts, request-timeouts, and any server error.
    return status === 408 || status === 409 || status === 429 || status >= 500
  }
  if (hasTransientNetworkCode(err)) return true
  const msg = String((err as { message?: unknown })?.message ?? err).toLowerCase()
  // fetch's own word for a response body cut off mid-read, whatever the cause chain
  // kept. Matched whole: a permanent error can say "terminated" in a sentence.
  if (msg.trim() === 'terminated') return true
  // The 5xx alternative is anchored to a status/http/code context so a bare 3-digit
  // number in a *permanent* error's text (e.g. "Requested 550 completions") isn't
  // mistaken for a retryable server error. (5xx status codes still go through the
  // numeric `status` branch above; this only covers messages that embed the status.)
  return /overloaded|rate.?limit|too many requests|timeout|timed out|econnreset|etimedout|enotfound|eai_again|socket hang up|network|fetch failed|temporarily|unavailable|connection (error|reset|closed|refused)|stream (closed|error|interrupted)|(?:status|http|code)[^0-9]{0,6}5\d\d\b/.test(
    msg
  )
}

/**
 * Whether a failure means the network never answered: a lookup, connect, reset, or a
 * body that dropped or stalled. Never one that carries an HTTP status, which means a
 * server did answer. A subset of {@link isRetryableError}.
 */
export function isNetworkError(err: unknown): boolean {
  if (typeof (err as { status?: unknown })?.status === 'number') return false
  if (hasTransientNetworkCode(err)) return true
  const msg = String((err as { message?: unknown })?.message ?? err).toLowerCase()
  if (msg.trim() === 'terminated') return true
  return /connection error|fetch failed|econnreset|econnrefused|etimedout|enotfound|eai_again|socket hang up|network/.test(msg)
}

/**
 * Decides, per provider call, whether a failed attempt gets another try. Transient
 * failures get {@link MAX_PROVIDER_RETRIES} attempts; a network outage, once the
 * provider has been reached in this run, gets {@link NETWORK_OUTAGE_BUDGET_MS} of wall
 * clock instead, measured from the first network failure of the current streak. Any
 * other failure in between ends the streak, so a provider that comes back overloaded
 * is held to the attempt count again.
 *
 * `reachable` reports whether the provider has answered in this run: a completed call,
 * or any output streamed before a drop. It's what separates a network that went away
 * from an address that never worked (a mistyped base URL fails with the same DNS
 * error, and shouldn't sit retrying for five minutes).
 */
export class RetryBudget {
  private outageSince: number | undefined
  private extendedIdleStalls = 0
  private lastWasExtendedIdle = false

  constructor(
    private readonly reachable: () => boolean,
    private readonly opts: { maxRetries?: number; now?: () => number } = {}
  ) {}

  /** Whether retry number `retry` (1-based) may go ahead after `err`. */
  allows(err: unknown, retry: number): boolean {
    if (!isRetryableError(err)) return false
    const idleWindow = streamIdleWindowOf(err)
    this.lastWasExtendedIdle = idleWindow !== undefined && idleWindow > STREAM_IDLE_TIMEOUT_MS
    if (this.lastWasExtendedIdle) {
      this.outageSince = undefined
      return ++this.extendedIdleStalls <= MAX_EXTENDED_IDLE_RETRIES
    }
    const now = this.opts.now ?? Date.now
    if (this.reachable() && isNetworkError(err)) {
      this.outageSince ??= now()
      return now() - this.outageSince < NETWORK_OUTAGE_BUDGET_MS
    }
    this.outageSince = undefined
    return retry <= (this.opts.maxRetries ?? MAX_PROVIDER_RETRIES)
  }

  /**
   * The attempt cap to report with a retry, or undefined while riding out an outage,
   * where the budget is time rather than a count. Read after {@link allows}.
   */
  get reportedMax(): number | undefined {
    if (this.lastWasExtendedIdle) return MAX_EXTENDED_IDLE_RETRIES
    return this.outageSince === undefined ? (this.opts.maxRetries ?? MAX_PROVIDER_RETRIES) : undefined
  }
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

/**
 * Whether a provider error means "this model id doesn't exist here, or this key can't
 * use it": a 404 that names the model or carries a model-not-found code. Anthropic
 * answers `not_found_error` with "model: <id>", OpenAI `model_not_found`, Gemini
 * "models/<id> is not found", Ollama `model "<id>" not found`. A bare 404 that names
 * neither (a wrong base URL, a proxy path) is deliberately not one: telling the user
 * to pick another model would send them the wrong way.
 */
export function isModelNotFoundError(err: unknown, model: string): boolean {
  const status = (err as { status?: unknown })?.status
  const msg = String((err as { message?: unknown })?.message ?? err)
  const is404 = status === 404 || (status === undefined && /^\s*404\b/.test(msg))
  if (!is404) return false
  if (model && msg.includes(model)) return true
  return /not_found_error|model_not_found|\bmodel\b[^.]{0,80}\b(?:not found|does not exist)/i.test(msg)
}

/**
 * The user-facing cause of a provider failure that ended a turn, read from the error
 * itself: its HTTP status first (a server that answered said exactly what was wrong),
 * then the network codes on its cause chain, then its wording. Undefined when none of
 * them says, so the client falls back to a generic "the turn failed".
 */
export function classifyProviderFailure(err: unknown): TurnErrorCause | undefined {
  if (isQuotaExhaustedError(err)) return 'quota'
  const status = (err as { status?: unknown })?.status
  // 402 Payment Required: the account can't pay for the request (OpenRouter's "requires
  // more credits"). Never retried, since waiting adds no credit.
  if (status === 402) return 'quota'
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate-limit'
  if (typeof status === 'number' && status >= 500) return 'provider-down'
  if (isNetworkError(err)) return 'network'
  return causeFromMessage(String((err as { message?: unknown })?.message ?? err))
}

/** A header's value as a non-negative whole number, or undefined. */
function headerCount(headers: unknown, names: string[]): number | undefined {
  for (const n of names) {
    const raw = headerValue(headers, n)?.trim()
    if (!raw) continue
    const v = Number(raw)
    if (Number.isFinite(v) && v >= 0) return Math.floor(v)
  }
  return undefined
}

/**
 * What to tell the user about a throttled attempt (a 429 that isn't an exhausted
 * quota), or undefined for any other failure. `waitMs` is the delay the loop chose.
 * Reads the remaining-quota headers Anthropic and OpenAI-style APIs send, when the
 * error kept them; nothing else from the response is read.
 */
export function throttleInfo(err: unknown, waitMs: number): ThrottleInfo | undefined {
  const status = (err as { status?: unknown })?.status
  if (status !== 429 || isQuotaExhaustedError(err)) return undefined
  const headers = (err as { headers?: unknown })?.headers
  const retryAfterMs = retryAfterHintMs(err)
  const remainingRequests = headerCount(headers, ['anthropic-ratelimit-requests-remaining', 'x-ratelimit-remaining-requests'])
  const remainingTokens = headerCount(headers, [
    'anthropic-ratelimit-tokens-remaining',
    'anthropic-ratelimit-input-tokens-remaining',
    'x-ratelimit-remaining-tokens'
  ])
  return {
    waitMs: Math.max(0, Math.round(waitMs)),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(remainingRequests !== undefined ? { remainingRequests } : {}),
    ...(remainingTokens !== undefined ? { remainingTokens } : {})
  }
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
 * Handles the parsed value an in-band {@link ProviderError} already carries, the
 * `retry-after-ms` header (OpenAI and Anthropic send it beside `Retry-After`), both
 * `Retry-After` forms (delta-seconds and HTTP-date), and the delay a Gemini error names
 * in its body (its SDK keeps no headers). Clamped to {@link RETRY_AFTER_CAP_MS}.
 */
export function retryAfterHintMs(err: unknown, now: number = Date.now()): number | undefined {
  const e = err as { retryAfterMs?: unknown; headers?: unknown } | null | undefined
  const direct = e?.retryAfterMs
  if (typeof direct === 'number' && Number.isFinite(direct) && direct >= 0) {
    return Math.min(direct, RETRY_AFTER_CAP_MS)
  }
  const rawMs = headerValue(e?.headers, 'retry-after-ms')?.trim()
  if (rawMs) {
    const ms = Number(rawMs)
    if (Number.isFinite(ms)) return ms <= 0 ? 0 : Math.min(ms, RETRY_AFTER_CAP_MS)
  }
  const raw = headerValue(e?.headers, 'retry-after')?.trim()
  if (raw) {
    const secs = Number(raw)
    if (Number.isFinite(secs)) return secs <= 0 ? 0 : Math.min(secs * 1000, RETRY_AFTER_CAP_MS)
    const at = Date.parse(raw)
    if (!Number.isNaN(at)) return Math.min(Math.max(0, at - now), RETRY_AFTER_CAP_MS)
  }
  const google = googleRetryDelayMs(err)
  return google === undefined ? undefined : Math.min(google, RETRY_AFTER_CAP_MS)
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
 * read. The main turn loop can't use this: it streams as it goes, so before it retries a
 * turn that had already streamed it emits `turn_discarded` for the clients to retract
 * what they showed. Callers that stream to a user must do the same.
 *
 * `signal` is the caller's own abort (Stop, or a bounding timeout); an abort is never
 * retried, and it cuts a pending backoff short rather than waiting it out.
 */
export async function withProviderRetry<T>(
  attempt: () => Promise<T>,
  opts: {
    signal?: AbortSignal
    maxRetries?: number
    /**
     * Whether the provider has answered in this run, which turns a network outage's
     * budget from the attempt count into {@link NETWORK_OUTAGE_BUDGET_MS} (see
     * {@link RetryBudget}). Omitted, the attempt count always applies.
     */
    reachable?: () => boolean
    /** `max` is undefined while riding out a network outage (a time budget, not a count). */
    onRetry?: (attempt: number, err: unknown, max: number | undefined) => void
  } = {}
): Promise<T> {
  const budget = new RetryBudget(opts.reachable ?? (() => false), { maxRetries: opts.maxRetries })
  const signal = opts.signal ?? new AbortController().signal
  for (let n = 0; ; n++) {
    try {
      return await attempt()
    } catch (e) {
      if (signal.aborted || !budget.allows(e, n + 1)) throw e
      opts.onRetry?.(n + 1, e, budget.reportedMax)
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
