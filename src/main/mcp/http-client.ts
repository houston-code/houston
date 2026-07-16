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
  kindOf,
  parseIncoming,
  type JsonRpcIncoming,
  type McpListKind
} from './protocol'
import { parseSseEvents } from './sse-client'

/**
 * A minimal MCP client over the **streamable HTTP** transport (the remote
 * counterpart to the stdio client). It speaks JSON-RPC 2.0 by POSTing each
 * request to a single endpoint URL; the server replies with either a JSON body
 * or a `text/event-stream` (SSE) body carrying the JSON-RPC response. A
 * `Mcp-Session-Id` returned on initialize is echoed on later requests.
 *
 * SSE response bodies are read incrementally, so server notifications embedded
 * in them (progress, list_changed) are acted on while the call is still running
 * rather than after it ends. After the handshake the client also holds the
 * transport's optional GET event-stream open for server-initiated messages;
 * servers that answer 405 simply don't get one. When the server expires the
 * session (404 on a stale `Mcp-Session-Id`), the client marks itself closed so
 * the manager reconnects with a fresh handshake.
 *
 * Enough to initialize, list tools, and call them — covering hosted MCP servers
 * without pulling in the full SDK. Like the stdio client, tool calls are still
 * gated by the agent's approval flow (kind "mcp" always prompts).
 */

const PROTOCOL_VERSION = '2025-06-18'
const INIT_TIMEOUT_MS = 20_000
const CALL_TIMEOUT_MS = 120_000

/** Pull each SSE event's `data:` payload out of a raw event-stream body. */
export function extractSseData(body: string): string[] {
  const out: string[] = []
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n')
    if (data.trim()) out.push(data)
  }
  return out
}

interface JsonRpcMessage {
  id?: number
  result?: unknown
  error?: { message?: string }
}

/**
 * Find the JSON-RPC response for `id` in an HTTP body, handling both a plain
 * JSON body and an SSE body (possibly carrying several messages). Returns null
 * if nothing parseable matches. Falls back to any lone response-shaped message,
 * tolerating servers that answer with a mismatched id.
 */
export function pickJsonRpc(contentType: string, body: string, id: number): JsonRpcMessage | null {
  const candidates: JsonRpcMessage[] = []
  const tryPush = (raw: string): void => {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) candidates.push(...(parsed as JsonRpcMessage[]))
      else candidates.push(parsed as JsonRpcMessage)
    } catch {
      // ignore non-JSON chunks
    }
  }
  if (contentType.includes('text/event-stream')) {
    for (const data of extractSseData(body)) tryPush(data)
  } else {
    tryPush(body)
  }
  if (candidates.length === 0) return null
  return candidates.find((m) => m.id === id) ?? candidates.find((m) => 'result' in m || 'error' in m) ?? null
}

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>

export class McpHttpClient implements McpConnection {
  private url = ''
  private extraHeaders: Record<string, string> = {}
  private sessionId?: string
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
  /** Aborts the standing GET notification stream on close. */
  private streamAbort?: AbortController
  tools: McpToolInfo[] = []
  resources: McpResourceInfo[] = []
  prompts: McpPromptInfo[] = []

  constructor(private readonly fetchFn: FetchFn = fetch) {}

  get isClosed(): boolean {
    return this.closed
  }

  /** Perform the initialize handshake against the endpoint and list its tools. */
  async connect(opts: { url: string; headers?: Record<string, string> }): Promise<void> {
    this.url = opts.url
    this.extraHeaders = opts.headers ?? {}
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
    this.openNotificationStream()
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

  close(): void {
    this.closed = true
    this.pending.failAll('MCP HTTP client closed')
    this.streamAbort?.abort()
  }

  // ---- transport internals ----

  private headers(): Record<string, string> {
    return {
      ...this.extraHeaders,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': PROTOCOL_VERSION,
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {})
    }
  }

  private async rpc(
    method: string,
    params: unknown,
    timeoutMs: number,
    opts: { progress?: boolean } = {}
  ): Promise<unknown> {
    if (this.closed) throw new Error('MCP HTTP client is closed')
    const id = this.nextId++
    // Ask for progress on long calls: a server that reports it keeps the call's
    // inactivity clock (see PendingRequests) from expiring mid-work.
    const sent = opts.progress
      ? { ...(params as Record<string, unknown>), _meta: { progressToken: id } }
      : params
    const result = this.pending.wait(id, method, timeoutMs)
    const controller = new AbortController()
    // Stop the transfer once the request settles, whichever way: the response
    // arrived (no need to drain the rest), it timed out, or the client closed.
    void result.catch(() => {}).finally(() => controller.abort())
    void this.performPost(id, method, { jsonrpc: '2.0', id, method, params: sent }, controller).catch(
      (e) => this.pending.reject(id, e as Error)
    )
    return result
  }

  /** POST one request and feed whatever comes back through the dispatcher. */
  private async performPost(
    id: number,
    method: string,
    payload: unknown,
    controller: AbortController
  ): Promise<void> {
    const res = await this.fetchFn(this.url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(payload),
      signal: controller.signal
    })
    const sid = res.headers.get('mcp-session-id')
    if (sid) this.sessionId = sid
    if (res.status === 401) {
      await res.text().catch(() => '')
      throw new McpUnauthorizedError(
        `MCP ${method} failed: HTTP 401 (the server rejected the credentials or requires OAuth sign-in)`,
        res.headers.get('www-authenticate')
      )
    }
    if (res.status === 404 && this.sessionId) {
      // The server expired our session (spec: 404 on a stale Mcp-Session-Id). A
      // mid-flight re-handshake can't be transparent, so mark the client dead;
      // the manager reconnects with a fresh initialize on the next call/run.
      await res.text().catch(() => '')
      this.closed = true
      this.pending.failAll(`MCP ${method} failed: the server expired the session`)
      return
    }
    const contentType = res.headers.get('content-type') ?? ''
    if (contentType.includes('text/event-stream') && res.body) {
      await this.readEventStream(res.body)
      if (this.pending.has(id)) {
        this.pending.reject(id, new Error(`MCP ${method} failed: stream ended without a response`))
      }
      return
    }
    const text = await res.text()
    if (!res.ok && !text) throw new Error(`MCP ${method} failed: HTTP ${res.status}`)
    this.dispatchBody(contentType, text)
    if (this.pending.has(id)) {
      // Lenient fallback: tolerate a server that answered with a mismatched id.
      const msg = pickJsonRpc(contentType, text, id)
      if (msg && ('result' in msg || 'error' in msg)) this.pending.settle(id, msg as JsonRpcIncoming)
      else this.pending.reject(id, new Error(`MCP ${method} failed: HTTP ${res.status} (no JSON-RPC response)`))
    }
  }

  /** Route one incoming message: settle a pending request or handle server traffic. */
  private dispatch(raw: unknown): void {
    const msg = parseIncoming(raw)
    if (!msg) return
    if (kindOf(msg) === 'response') {
      this.pending.settle(msg.id as number | string, msg)
      return
    }
    handleServerMessage(msg, {
      // Replies to server requests (ping, method-not-found) go out as their own
      // POST; the server acknowledges with a body-less 202.
      send: (payload) => void this.fireAndForget(payload),
      onListChanged: (kind) => this.refresher.schedule(kind),
      touchProgress: (token) => this.pending.touch(token)
    })
  }

  /** Dispatch every JSON-RPC message in a complete (non-streamed) body. */
  private dispatchBody(contentType: string, body: string): void {
    const payloads = contentType.includes('text/event-stream') ? extractSseData(body) : [body]
    for (const raw of payloads) {
      try {
        const parsed = JSON.parse(raw) as unknown
        for (const m of Array.isArray(parsed) ? parsed : [parsed]) this.dispatch(m)
      } catch {
        // ignore non-JSON chunks
      }
    }
  }

  /** Incrementally read an SSE body, dispatching each event as it arrives. */
  private async readEventStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const emit = (events: ReturnType<typeof parseSseEvents>['events']): void => {
      for (const e of events) {
        if (!e.data.trim()) continue
        try {
          const parsed = JSON.parse(e.data) as unknown
          for (const m of Array.isArray(parsed) ? parsed : [parsed]) this.dispatch(m)
        } catch {
          // ignore non-JSON events
        }
      }
    }
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const { events, rest } = parseSseEvents(buffer)
        buffer = rest
        emit(events)
      }
      // Some servers end the stream without a trailing blank line; flush the
      // remainder as a final event so that response isn't dropped.
      buffer += decoder.decode()
      if (buffer.trim()) emit(parseSseEvents(`${buffer}\n\n`).events)
    } catch {
      // Aborted (request settled / client closed) or the network dropped; any
      // still-pending request is settled by its own timers.
    }
  }

  /**
   * Hold the transport's optional GET event-stream open so server-initiated
   * messages (list_changed, pings) reach us between calls. Servers that don't
   * offer one answer 405 and lose nothing.
   */
  private openNotificationStream(): void {
    const controller = new AbortController()
    this.streamAbort = controller
    void (async () => {
      try {
        const res = await this.fetchFn(this.url, {
          method: 'GET',
          headers: {
            ...this.extraHeaders,
            accept: 'text/event-stream',
            'mcp-protocol-version': PROTOCOL_VERSION,
            ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {})
          },
          signal: controller.signal
        })
        if (!res.ok || !res.body) return
        if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) return
        await this.readEventStream(res.body)
      } catch {
        // The notification stream is optional; running without one loses nothing
        // beyond between-call notifications.
      }
    })()
  }

  /** POST a payload for which no reply is expected (notifications, request replies). */
  private async fireAndForget(payload: unknown): Promise<void> {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), INIT_TIMEOUT_MS)
      try {
        const res = await this.fetchFn(this.url, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(payload),
          signal: controller.signal
        })
        // Drain the (usually empty, 202) body so the connection can be reused.
        await res.text().catch(() => '')
      } finally {
        clearTimeout(timer)
      }
    } catch {
      // Best-effort by contract.
    }
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

  private async notify(method: string, params: unknown): Promise<void> {
    await this.fireAndForget({ jsonrpc: '2.0', method, params })
  }
}
