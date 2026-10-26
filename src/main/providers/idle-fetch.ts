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

/** Error code {@link StreamIdleError} carries; the retry policy matches on it. */
export const STREAM_IDLE_CODE = 'HOUSTON_STREAM_IDLE'

/** The response body went quiet for longer than the idle window. */
export class StreamIdleError extends Error {
  readonly code = STREAM_IDLE_CODE
  constructor(idleMs: number) {
    super(`Provider stream timed out: no data for ${Math.round(idleMs / 1000)}s`)
    this.name = 'StreamIdleError'
  }
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/**
 * Wrap `base` so every response body errors with {@link StreamIdleError} once it has
 * waited `idleMs` for its next chunk. The clock only runs while a read is pending, so
 * a consumer that's slow to read never trips it. Headers, status and an abort through
 * the request's own signal behave exactly as before.
 */
export function idleTimeoutFetch(
  idleMs: number = STREAM_IDLE_TIMEOUT_MS,
  base: Fetch = (input, init) => globalThis.fetch(input, init)
): Fetch {
  return async (input, init) => {
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
