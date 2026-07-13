import { flattenMcpContent, flattenMcpResourceContents } from '@shared/mcp'
import {
  mcpResourcesCapable,
  parseMcpResourceList,
  type McpConnection,
  type McpResourceInfo,
  type McpToolInfo
} from './client'

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

interface JsonRpcResponse {
  id?: number
  result?: unknown
  error?: { message?: string }
}

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

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
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
  private readonly pending = new Map<number, Pending>()
  /** Resolves once the server's `endpoint` event has set `postUrl`. */
  private endpointReady?: Promise<void>
  tools: McpToolInfo[] = []
  resources: McpResourceInfo[] = []

  constructor(
    private readonly connectStream: SseConnectFn = openEventSourceStream,
    private readonly fetchFn: FetchFn = fetch
  ) {}

  get isClosed(): boolean {
    return this.closed
  }

  /** Open the SSE stream, perform the initialize handshake, and list tools. */
  async connect(opts: { url: string; headers?: Record<string, string> }): Promise<void> {
    this.sseUrl = opts.url
    this.extraHeaders = opts.headers ?? {}

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
        capabilities: {},
        clientInfo: { name: 'Houston', version: '0.1.0' }
      },
      INIT_TIMEOUT_MS
    )
    await this.notify('notifications/initialized', {})
    const listed = (await this.rpc('tools/list', {}, INIT_TIMEOUT_MS)) as { tools?: McpToolInfo[] }
    this.tools = Array.isArray(listed?.tools) ? listed.tools : []

    // Only ask for resources when the server declared the capability.
    if (mcpResourcesCapable(init)) {
      try {
        this.resources = parseMcpResourceList(await this.rpc('resources/list', {}, INIT_TIMEOUT_MS))
      } catch {
        this.resources = []
      }
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const res = (await this.rpc('tools/call', { name, arguments: args ?? {} }, CALL_TIMEOUT_MS)) as {
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
    // Any other event (typically "message") carries a JSON-RPC response.
    let msg: JsonRpcResponse
    try {
      msg = JSON.parse(e.data) as JsonRpcResponse
    } catch {
      return // ignore non-JSON payloads
    }
    if (typeof msg.id !== 'number') return // server-initiated request/notification — unsupported
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    if (msg.error) p.reject(new Error(msg.error.message ?? 'MCP error'))
    else p.resolve(msg.result)
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

  private async rpc(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closed) throw new Error('MCP SSE client is closed')
    const id = this.nextId++
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP ${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        }
      })
    })
    try {
      await this.postMessage({ jsonrpc: '2.0', id, method, params })
    } catch (e) {
      this.pending.get(id)?.reject(e as Error)
      this.pending.delete(id)
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
    if (!res.ok) throw new Error(`MCP POST failed: HTTP ${res.status}`)
  }

  private failAll(message: string): void {
    this.closed = true
    for (const p of this.pending.values()) p.reject(new Error(message))
    this.pending.clear()
  }
}
