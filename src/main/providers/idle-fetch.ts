import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * A `fetch` for the provider SDKs that fails a response body which stops delivering
 * bytes. A network switch or a sleeping laptop can leave the streaming socket
 * half-open: no reset ever arrives, so the read just waits. The SDKs' own timeouts
 * stop at the response headers, and fetch's default body timeout is five minutes, so
 * a turn sat frozen that long before failing. This errors the body after
 * {@link STREAM_IDLE_TIMEOUT_MS} of silence with a code the retry policy treats as
 * transient (`isRetryableError`), so the loop redoes the turn on a fresh connection.
 *
 * The clock runs on raw bytes, not on parsed events: an adapter can go quiet while
 * the wire stays busy (a long tool call's JSON is buffered, not yielded), and the
 * hosts keep a healthy stream talking even while the model thinks (Anthropic sends
 * `ping` events, the Responses API streams progress and summary events).
 */

/**
 * Longest silence a response body may keep before it's treated as stalled. Generous on
 * purpose: cutting a stream that was only slow throws its turn away, and a host that
 * streams nothing while a model reasons privately can legitimately go quiet for a while.
 * Still well under fetch's own five-minute body timeout, which is what it replaces.
 */
export const STREAM_IDLE_TIMEOUT_MS = 120_000

/**
 * The idle window for streams that can honestly stay silent for minutes: a model served
 * from the user's own machine or network (a local server loading weights, or prefilling
 * a long prompt on modest hardware, sends nothing until the first token), and a Chat
 * Completions request that asked for reasoning (that API streams nothing while the model
 * thinks, so a long think looks exactly like a dead socket). Cutting those at the default
 * window threw away work the host was still doing, then paid for it again on the retry.
 */
export const EXTENDED_STREAM_IDLE_TIMEOUT_MS = 10 * 60_000

/**
 * The idle window a request made inside {@link withStreamIdleWindow} asks for. Read when
 * the request is sent, so a window set around an SDK call covers that call's stream.
 */
const requestedWindow = new AsyncLocalStorage<number>()

/**
 * Run `fn` with every stream it opens through {@link idleTimeoutFetch} allowed to stay
 * quiet for at least `ms`. Never shortens a fetch's own window, nor one an enclosing
 * call already asked for.
 */
export function withStreamIdleWindow<T>(ms: number, fn: () => T): T {
  return requestedWindow.run(Math.max(ms, requestedWindow.getStore() ?? 0), fn)
}

/** The window {@link withStreamIdleWindow} set for the current call, if any. */
export function requestedStreamIdleWindow(): number | undefined {
  return requestedWindow.getStore()
}

/**
 * Whether a base URL points at the user's own machine or private network: loopback,
 * `localhost` (and `*.localhost`), the unspecified address, a private IPv4 range, an
 * mDNS `.local` name, or an IPv6 unique-local address. That's where self-hosted model
 * servers (Ollama, LM Studio, vLLM, llama.cpp) live. A malformed URL is not local.
 */
export function isLocalModelHost(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false
  let host: string
  try {
    host = new URL(baseUrl).hostname.toLowerCase()
  } catch {
    return false
  }
  host = host.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (host === '::1' || host === '::' || host === '0.0.0.0') return true
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host)
  if (!v4) return false
  const [a, b] = [Number(v4[1]), Number(v4[2])]
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
}

/** The idle window for a provider client talking to `baseUrl`. */
export function streamIdleTimeoutFor(baseUrl: string | undefined): number {
  return isLocalModelHost(baseUrl) ? EXTENDED_STREAM_IDLE_TIMEOUT_MS : STREAM_IDLE_TIMEOUT_MS
}

/**
 * Deadline for a model-listing request ("Fetch models", "Test key"): the response must
 * start within it, and its body may not go quiet for longer. The SDKs' own default is ten
 * minutes for the headers alone, and the Gemini SDK sets none at all, so on a network
 * that drops packets the button just spun. A listing is one small JSON reply, so a host
 * that hasn't answered in this long isn't going to.
 */
export const LIST_MODELS_TIMEOUT_MS = 15_000

/** Error code {@link StreamIdleError} carries; the retry policy matches on it. */
export const STREAM_IDLE_CODE = 'HOUSTON_STREAM_IDLE'

/** The response body went quiet for longer than the idle window. */
export class StreamIdleError extends Error {
  readonly code = STREAM_IDLE_CODE
  constructor(readonly idleMs: number) {
    super(`Provider stream timed out: no data for ${Math.round(idleMs / 1000)}s`)
    this.name = 'StreamIdleError'
  }
}

/**
 * A response body ended cleanly but before the reply's terminal event (a proxy or a
 * dropped connection closing the stream), so the reply was cut off somewhere unknown.
 * Its message reads as a closed stream, which the retry policy treats as transient; it
 * carries no network code, so it counts against the attempt budget rather than the
 * outage window (a proxy that always cuts the stream must not retry for minutes).
 */
export class StreamClosedEarlyError extends Error {
  constructor(cause?: unknown) {
    super('Provider stream closed before the reply finished.', cause === undefined ? undefined : { cause })
    this.name = 'StreamClosedEarlyError'
  }
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/**
 * The idle window of the {@link StreamIdleError} on `err` or its `cause` chain (the SDKs
 * may wrap it), or undefined when the failure wasn't an idle stall.
 */
export function streamIdleWindowOf(err: unknown): number | undefined {
  let e: unknown = err
  // Bounded walk: a cause chain can be cyclic.
  for (let i = 0; i < 8 && e !== undefined && e !== null; i++) {
    if ((e as { code?: unknown }).code === STREAM_IDLE_CODE) {
      const ms = (e as { idleMs?: unknown }).idleMs
      return typeof ms === 'number' ? ms : STREAM_IDLE_TIMEOUT_MS
    }
    const next = (e as { cause?: unknown }).cause
    if (next === e) break
    e = next
  }
  return undefined
}

/**
 * Wrap `base` so every response body errors with {@link StreamIdleError} once it has
 * waited `idleMs` (or the longer window {@link withStreamIdleWindow} asked for around
 * the request) for its next chunk. The clock only runs while a read is pending, so
 * a consumer that's slow to read never trips it. Headers, status and an abort through
 * the request's own signal behave exactly as before.
 */
export function idleTimeoutFetch(
  baseIdleMs: number = STREAM_IDLE_TIMEOUT_MS,
  base: Fetch = (input, init) => globalThis.fetch(input, init)
): Fetch {
  return async (input, init) => {
    const idleMs = Math.max(baseIdleMs, requestedWindow.getStore() ?? 0)
    const res = await base(input, init)
    // Statuses that can never carry a body; wrapping one would make Response throw.
    if (!res.body || [101, 204, 205, 304].includes(res.status)) return res
    const reader = res.body.getReader()
    let timer: ReturnType<typeof setTimeout> | undefined
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const idle = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new StreamIdleError(idleMs)), idleMs)
        })
        try {
          const chunk = await Promise.race([reader.read(), idle])
          if (chunk.done) controller.close()
          else controller.enqueue(chunk.value)
        } catch (e) {
          // Release the dead socket; the read it leaves pending settles harmlessly.
          if (e instanceof StreamIdleError) reader.cancel(e).catch(() => {})
          throw e
        } finally {
          clearTimeout(timer)
        }
      },
      cancel(reason) {
        clearTimeout(timer)
        return reader.cancel(reason)
      }
    })
    const wrapped = new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers })
    // `url` and `redirected` aren't constructor options; keep them for anything that logs them.
    Object.defineProperty(wrapped, 'url', { value: res.url })
    Object.defineProperty(wrapped, 'redirected', { value: res.redirected })
    return wrapped
  }
}
