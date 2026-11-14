import { outboundFetch } from '../outbound-proxy'
import {
  flattenMcpContent,
  flattenMcpPromptMessages,
  flattenMcpResourceContents,
  type McpImageOptions
} from '@shared/mcp'
import {
  McpUnauthorizedError,
  mcpCapable,
  parseMcpPromptList,
  parseMcpResourceList,
  parseMcpToolList,
  type McpConnection,
  type McpPromptInfo,
  type McpResourceInfo,
  type McpToolInfo
} from './client'
import {
  initializeParams,
  negotiatedProtocolVersion,
  supportsElicitation,
  type McpProtocolVersion
} from './version'
import {
  ListRefresher,
  PendingRequests,
  cancelledNotification,
  handleServerMessage,
  keepAliveDuring,
  kindOf,
  mcpCancelledError,
  parseIncoming,
  type ElicitationWireResult,
  listAllPages,
  type ListedPages,
  type McpListKind
} from './protocol'

/**
 * A minimal MCP client over the **legacy HTTP+SSE** transport (MCP protocol
 * 2024-11-05), the predecessor to streamable HTTP. Unlike streamable HTTP — one
 * endpoint that answers each POST inline — the SSE transport splits the channel:
 *
 *   1. The client opens a long-lived `GET` to the SSE URL (an `text/event-stream`).
 *   2. The server's first event is `endpoint`, whose data is the URL the client
 *      POSTs JSON-RPC requests to (often relative — resolved against the SSE URL).
 *   3. Each POST is answered out-of-band: the server replies `202 Accepted` to the
 *      POST and delivers the matching JSON-RPC response later as a `message` event
 *      on the persistent GET stream.
 *
 * Enough to initialize, list tools, and call them. Optional static auth (a bearer
 * token or arbitrary custom headers) is sent on both the GET and every POST — this
 * is NOT OAuth dynamic registration, just fixed headers the user supplies. Tool
 * calls are still gated by the agent's approval flow (kind "mcp" always prompts).
 */

const INIT_TIMEOUT_MS = 20_000
const CALL_TIMEOUT_MS = 120_000

/** One Server-Sent Event, as delivered by the stream seam. */
export interface SseEvent {
  /** The event type (`event:` line); defaults to "message" when omitted. */
  event: string
  /** The concatenated `data:` payload. */
  data: string
  /** The event's `id:`, when it had one: a streamable-HTTP client resumes after it. */
  id?: string
  /** The `retry:` reconnect delay in milliseconds, when the event set one. */
  retry?: number
}

/** The longest SSE event id kept for resuming a stream. */
const MAX_SSE_EVENT_ID_CHARS = 1_024

/**
 * A connected SSE stream the client reads. Modeled on the parts of the DOM
 * `EventSource` the client needs, but transport-agnostic so tests can inject a
 * fake. `onEvent` receives every event (typed and untyped); `onError` fires on a
 * stream-level failure. `close` tears the stream down.
 */
export interface SseStream {
  close(): void
}

/**
 * Opens an SSE stream for `url` with `headers`, wiring the provided callbacks.
 * The real implementation (see `openEventSourceStream`) uses fetch + a streaming
 * body reader; tests inject a fake that drives `onEvent`/`onError` directly.
 */
export type SseConnectFn = (
  url: string,
  headers: Record<string, string>,
  handlers: { onEvent: (e: SseEvent) => void; onError: (err: Error) => void }
) => SseStream | Promise<SseStream>

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>

/**
 * Largest single message (one SSE event, or one line of a stdio server) accepted from
 * an MCP server, in characters. A server that sends more without ending the message is
 * treated as broken rather than buffered without limit.
 */
export const MAX_MCP_MESSAGE_CHARS = 64 * 1024 * 1024

/**
 * A response body as text, read at most `max` characters deep. `Response.text()`
 * buffers whatever the server sends, so a hostile or broken server answering a POST
 * with an endless JSON body (or a huge error page) would grow the main process's
 * memory without bound; the SSE path already caps each event at the same
 * {@link MAX_MCP_MESSAGE_CHARS}. Past the cap the transfer is cancelled and this
 * rejects with a "larger than" error, which fails the request it answered.
 */
export async function readCappedText(res: Response, max = MAX_MCP_MESSAGE_CHARS): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const parts: string[] = []
  let chars = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    const text = decoder.decode(value, { stream: true })
    chars += text.length
    if (chars > max) {
      await reader.cancel().catch(() => {})
      throw new Error(`MCP server sent a response larger than ${max / 1024 / 1024} MB`)
    }
    parts.push(text)
  }
  parts.push(decoder.decode())
  return parts.join('')
}

/**
 * Collects a streamed SSE body and returns each event once it is complete.
 *
 * Re-parsing the whole buffer on every network chunk re-scanned a large event from the
 * start each time (quadratic: a 20 MB result took seconds). This keeps the chunks apart
 * and only joins and parses them when one could have ended an event, which a blank
 * line does; the last few characters of the previous chunk are checked too, since the
 * blank line can be split across two chunks.
 */
export class SseEventBuffer {
  private chunks: string[] = []
  private chars = 0
  /** The end of what is buffered: enough to spot a blank line split across chunks. */
  private tail = ''

  /** Add decoded text; returns the events it completed. Throws past the message cap. */
  push(text: string): SseEvent[] {
    if (!text) return []
    const probe = this.tail + text
    this.tail = probe.slice(-3)
    this.chunks.push(text)
    this.chars += text.length
    if (!/\r?\n\r?\n/.test(probe)) {
      if (this.chars > MAX_MCP_MESSAGE_CHARS) {
        throw new Error(`MCP server sent an event larger than ${MAX_MCP_MESSAGE_CHARS / 1024 / 1024} MB`)
      }
      return []
    }
    const { events, rest } = parseSseEvents(this.chunks.join(''))
    this.chunks = rest ? [rest] : []
    this.chars = rest.length
    this.tail = rest.slice(-3)
    return events
  }

  /** The stream ended: return what is left as a final event, if anything. */
  finish(text = ''): SseEvent[] {
    const rest = this.chunks.join('') + text
    this.chunks = []
    this.chars = 0
    this.tail = ''
    return rest.trim() ? parseSseEvents(`${rest}\n\n`).events : []
  }
}

/**
 * Parse a raw SSE event-stream chunk-buffer into discrete events. Returns the
 * complete events and the unterminated remainder (kept for the next chunk).
 * Events are separated by a blank line; `event:`/`data:` lines accumulate.
 */
export function parseSseEvents(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = []
  // Split on a blank line (event boundary). The final segment may be partial.
  const segments = buffer.split(/\r?\n\r?\n/)
  const rest = segments.pop() ?? ''
  for (const segment of segments) {
    let event = 'message'
    let id: string | undefined
    let retry: number | undefined
    const dataLines: string[] = []
    for (const line of segment.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
      else if (line.startsWith('id:')) {
        // Per the SSE spec an id holding NUL is ignored; an overlong one is not worth resuming from.
        const value = line.slice(3).replace(/^ /, '')
        if (!value.includes('\u0000') && value.length <= MAX_SSE_EVENT_ID_CHARS) id = value
      } else if (/^retry: ?\d+$/.test(line)) retry = Number(line.slice(6).trim())
      // Comments (`:`) and unknown fields are ignored.
    }
    // An event with only an id (a server priming a stream it may close and have the
    // client resume) still counts: its id is where a resume starts.
    if (dataLines.length > 0 || event !== 'message' || id !== undefined || retry !== undefined) {
      events.push({
        event,
        data: dataLines.join('\n'),
        ...(id !== undefined ? { id } : {}),
        ...(retry !== undefined ? { retry } : {})
      })
    }
  }
  return { events, rest }
}

/**
 * The default SSE stream opener: a `GET` whose `text/event-stream` body is read
 * incrementally and split into events. Used in production; tests inject a fake
 * `SseConnectFn` instead so no real socket is opened.
 */
export const openEventSourceStream: SseConnectFn = (url, headers, { onEvent, onError }) => {
  const controller = new AbortController()
  let cancelled = false
  void (async () => {
    try {
      const res = await outboundFetch(url, {
        method: 'GET',
        headers: { ...headers, accept: 'text/event-stream' },
        signal: controller.signal
      })
      if (res.status === 401) {
        throw new McpUnauthorizedError(
          'SSE stream failed: HTTP 401 (the server rejected the credentials or requires OAuth sign-in)',
          res.headers.get('www-authenticate')
        )
      }
      if (!res.ok || !res.body) {
        throw new Error(`SSE stream failed: HTTP ${res.status}`)
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      const buffer = new SseEventBuffer()
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        for (const e of buffer.push(decoder.decode(value, { stream: true }))) onEvent(e)
      }
      if (!cancelled) onError(new Error('SSE stream closed'))
    } catch (err) {
      if (!cancelled) onError(err as Error)
    }
  })()
  return {
    close(): void {
      cancelled = true
      controller.abort()
    }
  }
}

/** Whether two URLs share an origin (scheme + host + port). */
function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}

export class McpSseClient implements McpConnection {
  private extraHeaders: Record<string, string> = {}
  private sseUrl = ''
  private postUrl?: string
  private stream?: SseStream
  private nextId = 1
  private closed = false
  private readonly pending = new PendingRequests()
  /** Capabilities the server declared at initialize (gates list re-fetches). */
  private capable: Record<McpListKind, boolean> = { tools: true, resources: false, prompts: false }
  private readonly refresher = new ListRefresher({
    isClosed: () => this.closed,
    capable: (kind) => this.capable[kind],
    fetch: (kind) => this.refreshList(kind)
  })
  /** Resolves once the server's `endpoint` event has set `postUrl`. */
  private endpointReady?: Promise<void>
  /** Answers `elicitation/create`; its presence declares the capability. */
  /** The version agreed at initialize; set once the handshake answers. */
  private protocolVersion?: McpProtocolVersion
  private onElicit?: (params: unknown) => Promise<ElicitationWireResult>
  tools: McpToolInfo[] = []
  droppedTools: string[] = []
  listNotes: Partial<Record<McpListKind, string>> = {}
  resources: McpResourceInfo[] = []
  prompts: McpPromptInfo[] = []

  constructor(
    private readonly connectStream: SseConnectFn = openEventSourceStream,
    private readonly fetchFn: FetchFn = outboundFetch
  ) {}

  get isClosed(): boolean {
    return this.closed
  }

  /** Open the SSE stream, perform the initialize handshake, and list tools. */
  async connect(opts: {
    url: string
    headers?: Record<string, string>
    onElicit?: (params: unknown) => Promise<ElicitationWireResult>
  }): Promise<void> {
    this.sseUrl = opts.url
    this.extraHeaders = opts.headers ?? {}
    this.onElicit = opts.onElicit

    let resolveEndpoint!: () => void
    let rejectEndpoint!: (e: Error) => void
    this.endpointReady = new Promise<void>((resolve, reject) => {
      resolveEndpoint = resolve
      rejectEndpoint = reject
    })

    this.stream = await this.connectStream(this.sseUrl, this.streamHeaders(), {
      onEvent: (e) => this.onEvent(e, resolveEndpoint, rejectEndpoint),
      onError: (err) => {
        rejectEndpoint(err)
        this.failAll(`SSE stream error: ${err.message}`)
      }
    })

    await this.waitForEndpoint(INIT_TIMEOUT_MS)
    const init = await this.rpc(
      'initialize',
      initializeParams({ elicitation: !!this.onElicit }),
      INIT_TIMEOUT_MS
    )
    this.protocolVersion = negotiatedProtocolVersion(init)
    // A server that negotiated down to a version without elicitation never gets
    // an elicitation answer: its requests fall through to the -32601 decline.
    if (!supportsElicitation(this.protocolVersion)) this.onElicit = undefined
    await this.notify('notifications/initialized', {})
    const listed = await this.fetchList('tools')
    this.setTools(listed)

    // Only ask for resources/prompts when the server declared the capability.
    this.capable.resources = mcpCapable(init, 'resources')
    this.capable.prompts = mcpCapable(init, 'prompts')
    if (this.capable.resources) {
      try {
        this.resources = parseMcpResourceList(await this.fetchList('resources'))
      } catch {
        this.resources = []
      }
    }
    if (this.capable.prompts) {
      try {
        this.prompts = parseMcpPromptList(await this.fetchList('prompts'))
      } catch {
        this.prompts = []
      }
    }
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal, images?: McpImageOptions): Promise<string> {
    const res = (await this.rpc('tools/call', { name, arguments: args ?? {} }, CALL_TIMEOUT_MS, {
      progress: true,
      signal
    })) as {
      content?: unknown
      isError?: boolean
    }
    const text = flattenMcpContent(res?.content, images)
    return res?.isError ? `${text}\n[the MCP tool reported an error]`.trim() : text || '[no output]'
  }

  /** Read a resource's contents by uri, flattened to text. */
  async readResource(uri: string, signal?: AbortSignal): Promise<string> {
    const res = await this.rpc('resources/read', { uri }, CALL_TIMEOUT_MS, { signal })
    return flattenMcpResourceContents(res) || '[no content]'
  }

  /** Fetch a prompt template by name, flattened to text. */
  async getPrompt(name: string, args: Record<string, string>, signal?: AbortSignal): Promise<string> {
    const res = await this.rpc('prompts/get', { name, arguments: args ?? {} }, CALL_TIMEOUT_MS, { signal })
    return flattenMcpPromptMessages(res) || '[no content]'
  }

  /** Re-fetch one changed list in place (driven by the ListRefresher). */
  private async refreshList(kind: McpListKind): Promise<void> {
    if (kind === 'tools') {
      const listed = await this.fetchList('tools')
      if (Array.isArray(listed?.tools)) this.setTools(listed)
    } else if (kind === 'resources') {
      this.resources = parseMcpResourceList(await this.fetchList('resources'))
    } else {
      this.prompts = parseMcpPromptList(await this.fetchList('prompts'))
    }
  }

  /** Fetch a whole list, every page (see listAllPages), noting when it was cut short. */
  private async fetchList(kind: McpListKind): Promise<ListedPages> {
    const listed = await listAllPages((params) => this.rpc(`${kind}/list`, params, INIT_TIMEOUT_MS), kind)
    if (listed.truncated) this.listNotes[kind] = listed.truncated
    else delete this.listNotes[kind]
    return listed
  }

  /** Take a `tools/list` result, keeping only well-formed tools (see parseMcpToolList). */
  private setTools(listed: unknown): void {
    const dropped: string[] = []
    this.tools = parseMcpToolList(listed, dropped)
    this.droppedTools = dropped
  }

  close(): void {
    this.closed = true
    this.failAll('MCP SSE client closed')
    this.stream?.close()
  }

  // ---- transport internals ----

  /** Headers for the GET stream — auth/custom headers, plus the SSE accept. */
  private streamHeaders(): Record<string, string> {
    return { ...this.extraHeaders, accept: 'text/event-stream' }
  }

  /** Headers for each JSON-RPC POST — auth/custom headers, plus JSON content type. */
  private postHeaders(): Record<string, string> {
    return {
      ...this.extraHeaders,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      // The negotiated version, once there is one (the initialize POST goes without).
      ...(this.protocolVersion ? { 'mcp-protocol-version': this.protocolVersion } : {})
    }
  }

  /** Handle one event off the SSE stream: the endpoint URL or a JSON-RPC reply. */
  private onEvent(e: SseEvent, resolveEndpoint: () => void, rejectEndpoint: (err: Error) => void): void {
    if (e.event === 'endpoint') {
      // The endpoint is usually relative; resolve it against the SSE URL.
      let resolved: string
      try {
        resolved = new URL(e.data.trim(), this.sseUrl).toString()
      } catch {
        rejectEndpoint(new Error(`MCP SSE server sent an invalid endpoint: ${e.data.trim()}`))
        return
      }
      // SECURITY: the endpoint is server-controlled and every subsequent JSON-RPC
      // POST carries the user's auth headers. Refuse an endpoint whose origin differs
      // from the SSE URL, so a malicious or compromised server can't redirect those
      // authenticated POSTs (and the bearer token they carry) to an attacker host.
      if (!sameOrigin(resolved, this.sseUrl)) {
        rejectEndpoint(
          new Error(
            `MCP SSE server advertised a cross-origin endpoint (${new URL(resolved).origin}); refusing to send credentials off-origin.`
          )
        )
        return
      }
      this.postUrl = resolved
      resolveEndpoint()
      return
    }
    // Any other event (typically "message") carries a JSON-RPC message: a
    // response to one of our requests, or a server-initiated request/notification.
    let raw: unknown
    try {
      raw = JSON.parse(e.data)
    } catch {
      return // ignore non-JSON payloads
    }
    const msg = parseIncoming(raw)
    if (!msg) return
    if (kindOf(msg) === 'response') {
      this.pending.settle(msg.id as number | string, msg)
      return
    }
    handleServerMessage(msg, {
      // Replies (ping results, elicitation answers, method-not-found) go out
      // over the POST channel.
      send: (payload) => void this.postMessage(payload).catch(() => {}),
      onListChanged: (kind) => this.refresher.schedule(kind),
      touchProgress: (token) => this.pending.touch(token),
      ...(this.onElicit
        ? { onElicit: (p: unknown) => keepAliveDuring(this.pending, () => this.onElicit!(p)) }
        : {})
    })
  }

  private waitForEndpoint(timeoutMs: number): Promise<void> {
    const ready = this.endpointReady
    if (!ready) return Promise.reject(new Error('SSE stream not opened'))
    // Cleared once the race settles: left armed, the timer outlived every connect by
    // its full 20 seconds and kept a finished one-shot CLI run from exiting.
    let timer: ReturnType<typeof setTimeout> | undefined
    return Promise.race([
      ready,
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error('MCP SSE endpoint handshake timed out')), timeoutMs)
      })
    ]).finally(() => clearTimeout(timer))
  }

  private async rpc(
    method: string,
    params: unknown,
    timeoutMs: number,
    opts: { progress?: boolean; signal?: AbortSignal } = {}
  ): Promise<unknown> {
    if (this.closed) throw new Error('MCP SSE client is closed')
    // Stopped before it went out: nothing to send, and nothing to cancel.
    if (opts.signal?.aborted) throw mcpCancelledError(method)
    const id = this.nextId++
    // Ask for progress on long calls: a server that reports it keeps the call's
    // inactivity clock (see PendingRequests) from expiring mid-work.
    const sent = opts.progress
      ? { ...(params as Record<string, unknown>), _meta: { progressToken: id } }
      : params
    const result = this.pending.wait(id, method, timeoutMs, undefined, {
      signal: opts.signal,
      onCancel: () => {
        if (!this.closed) void this.postMessage(cancelledNotification(id), INIT_TIMEOUT_MS).catch(() => {})
      }
    })
    // `result` can reject on its own timeout before this method returns it to the caller
    // (when the POST below hangs to that same deadline); handle it on a side-chain so
    // that brief window isn't reported as an unhandled rejection.
    void result.catch(() => {})
    try {
      // The run's Stop also abandons a POST the server has not acknowledged yet.
      await this.postMessage({ jsonrpc: '2.0', id, method, params: sent }, timeoutMs, opts.signal)
    } catch (e) {
      this.pending.reject(id, e as Error)
    }
    return result
  }

  private async notify(method: string, params: unknown): Promise<void> {
    try {
      await this.postMessage({ jsonrpc: '2.0', method, params })
    } catch {
      // Notifications are best-effort; a server that ignores them is fine.
    }
  }

  /**
   * POST a JSON-RPC payload to the server-advertised endpoint URL. Bounded by its own
   * AbortController: without one, a server that accepts the connection but never
   * responds (or trickles the 202 body) would hang the POST indefinitely — and since
   * rpc awaits this before returning the timeout-guarded result promise, that hung the
   * whole call past its per-call timeout. The timer stays live across the body drain so
   * a stalled body can't slip past it either.
   */
  private async postMessage(payload: unknown, timeoutMs = CALL_TIMEOUT_MS, signal?: AbortSignal): Promise<void> {
    if (!this.postUrl) throw new Error('MCP SSE endpoint not yet known')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const onAbort = (): void => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const res = await this.fetchFn(this.postUrl, {
        method: 'POST',
        headers: this.postHeaders(),
        body: JSON.stringify(payload),
        signal: controller.signal
      })
      // The JSON-RPC response arrives over the SSE stream, not in this body. Drain
      // the (usually empty, 202) body so the connection can be reused.
      await readCappedText(res).catch(() => '')
      if (res.status === 401) {
        // Rejected credentials won't recover on this connection: mark it dead so the
        // manager reconnects (refreshing the OAuth token) instead of reusing it.
        this.closed = true
        throw new McpUnauthorizedError(
          'MCP POST failed: HTTP 401 (the server rejected the credentials or requires OAuth sign-in)',
          res.headers.get('www-authenticate')
        )
      }
      if (!res.ok) throw new Error(`MCP POST failed: HTTP ${res.status}`)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  private failAll(message: string): void {
    this.closed = true
    this.pending.failAll(message)
  }
}
