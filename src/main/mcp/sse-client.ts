import { flattenMcpContent, flattenMcpPromptMessages, flattenMcpResourceContents } from '@shared/mcp'
import {
  McpUnauthorizedError,
  mcpCapable,
  parseMcpPromptList,
  parseMcpResourceList,
  type McpConnection,
  type McpPromptInfo,
  type McpResourceInfo,
  type McpToolInfo
} from './client'
import {
  ListRefresher,
  PendingRequests,
  handleServerMessage,
  keepAliveDuring,
  kindOf,
  parseIncoming,
  type ElicitationWireResult,
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

const PROTOCOL_VERSION = '2024-11-05'
const INIT_TIMEOUT_MS = 20_000
const CALL_TIMEOUT_MS = 120_000

/** One Server-Sent Event, as delivered by the stream seam. */
export interface SseEvent {
  /** The event type (`event:` line); defaults to "message" when omitted. */
  event: string
  /** The concatenated `data:` payload. */
  data: string
}

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
    const dataLines: string[] = []
    for (const line of segment.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
      // `id:` / `retry:` / comments (`:`) are accepted and ignored.
    }
    if (dataLines.length > 0 || event !== 'message') {
      events.push({ event, data: dataLines.join('\n') })
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
      const res = await fetch(url, {
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
      let buffer = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const { events, rest } = parseSseEvents(buffer)
        buffer = rest
        for (const e of events) onEvent(e)
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
  private onElicit?: (params: unknown) => Promise<ElicitationWireResult>
  tools: McpToolInfo[] = []
  resources: McpResourceInfo[] = []
  prompts: McpPromptInfo[] = []

  constructor(
    private readonly connectStream: SseConnectFn = openEventSourceStream,
    private readonly fetchFn: FetchFn = fetch
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
      {
        protocolVersion: PROTOCOL_VERSION,
        // Declare elicitation only when a responder is wired: declaring it and
        // then -32601ing the request would be lying to the server.
        capabilities: this.onElicit ? { elicitation: {} } : {},
        clientInfo: { name: 'Houston', version: '0.1.0' }
      },
      INIT_TIMEOUT_MS
    )
    await this.notify('notifications/initialized', {})
    const listed = (await this.rpc('tools/list', {}, INIT_TIMEOUT_MS)) as { tools?: McpToolInfo[] }
    this.tools = Array.isArray(listed?.tools) ? listed.tools : []

    // Only ask for resources/prompts when the server declared the capability.
    this.capable.resources = mcpCapable(init, 'resources')
    this.capable.prompts = mcpCapable(init, 'prompts')
    if (this.capable.resources) {
      try {
        this.resources = parseMcpResourceList(await this.rpc('resources/list', {}, INIT_TIMEOUT_MS))
      } catch {
        this.resources = []
      }
    }
    if (this.capable.prompts) {
      try {
        this.prompts = parseMcpPromptList(await this.rpc('prompts/list', {}, INIT_TIMEOUT_MS))
      } catch {
        this.prompts = []
      }
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const res = (await this.rpc('tools/call', { name, arguments: args ?? {} }, CALL_TIMEOUT_MS, {
      progress: true
    })) as {
      content?: unknown
      isError?: boolean
    }
    const text = flattenMcpContent(res?.content)
    return res?.isError ? `${text}\n[the MCP tool reported an error]`.trim() : text || '[no output]'
  }

  /** Read a resource's contents by uri, flattened to text. */
  async readResource(uri: string): Promise<string> {
    const res = await this.rpc('resources/read', { uri }, CALL_TIMEOUT_MS)
    return flattenMcpResourceContents(res) || '[no content]'
  }

  /** Fetch a prompt template by name, flattened to text. */
  async getPrompt(name: string, args: Record<string, string>): Promise<string> {
    const res = await this.rpc('prompts/get', { name, arguments: args ?? {} }, CALL_TIMEOUT_MS)
    return flattenMcpPromptMessages(res) || '[no content]'
  }

  /** Re-fetch one changed list in place (driven by the ListRefresher). */
  private async refreshList(kind: McpListKind): Promise<void> {
    if (kind === 'tools') {
      const listed = (await this.rpc('tools/list', {}, INIT_TIMEOUT_MS)) as { tools?: McpToolInfo[] }
      this.tools = Array.isArray(listed?.tools) ? listed.tools : this.tools
    } else if (kind === 'resources') {
      this.resources = parseMcpResourceList(await this.rpc('resources/list', {}, INIT_TIMEOUT_MS))
    } else {
      this.prompts = parseMcpPromptList(await this.rpc('prompts/list', {}, INIT_TIMEOUT_MS))
    }
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
      'mcp-protocol-version': PROTOCOL_VERSION
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
    return Promise.race([
      ready,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('MCP SSE endpoint handshake timed out')), timeoutMs)
      )
    ])
  }

  private async rpc(
    method: string,
    params: unknown,
    timeoutMs: number,
    opts: { progress?: boolean } = {}
  ): Promise<unknown> {
    if (this.closed) throw new Error('MCP SSE client is closed')
    const id = this.nextId++
    // Ask for progress on long calls: a server that reports it keeps the call's
    // inactivity clock (see PendingRequests) from expiring mid-work.
    const sent = opts.progress
      ? { ...(params as Record<string, unknown>), _meta: { progressToken: id } }
      : params
    const result = this.pending.wait(id, method, timeoutMs)
    try {
      await this.postMessage({ jsonrpc: '2.0', id, method, params: sent })
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

  /** POST a JSON-RPC payload to the server-advertised endpoint URL. */
  private async postMessage(payload: unknown): Promise<void> {
    if (!this.postUrl) throw new Error('MCP SSE endpoint not yet known')
    const res = await this.fetchFn(this.postUrl, {
      method: 'POST',
      headers: this.postHeaders(),
      body: JSON.stringify(payload)
    })
    // The JSON-RPC response arrives over the SSE stream, not in this body. Drain
    // the (usually empty, 202) body so the connection can be reused.
    await res.text().catch(() => '')
    if (res.status === 401) {
      throw new McpUnauthorizedError(
        'MCP POST failed: HTTP 401 (the server rejected the credentials or requires OAuth sign-in)',
        res.headers.get('www-authenticate')
      )
    }
    if (!res.ok) throw new Error(`MCP POST failed: HTTP ${res.status}`)
  }

  private failAll(message: string): void {
    this.closed = true
    this.pending.failAll(message)
  }
}
