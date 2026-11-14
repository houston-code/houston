import { outboundFetch } from '../outbound-proxy'
import { flattenMcpContent, flattenMcpPromptMessages, flattenMcpResourceContents } from '@shared/mcp'
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
  type JsonRpcIncoming,
  listAllPages,
  type ListedPages,
  type McpListKind
} from './protocol'
import { SseEventBuffer, type SseEvent } from './sse-client'

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

const INIT_TIMEOUT_MS = 20_000
const CALL_TIMEOUT_MS = 120_000
/** First wait before reopening a dropped notification stream; doubles per failure. */
const STREAM_RETRY_BASE_MS = 1_000
/** Longest wait between reopen attempts. */
const STREAM_RETRY_MAX_MS = 60_000
/** A stream that stayed open this long resets the backoff when it drops. */
const STREAM_HEALTHY_MS = 30_000

/** A resume wait when the server gave no `retry` hint. */
const DEFAULT_RESUME_DELAY_MS = 1_000
/** Bounds on a server's `retry` hint, so it can neither spin the client nor stall it. */
const MIN_RESUME_DELAY_MS = 250
const MAX_RESUME_DELAY_MS = 30_000
/** Resumed streams in a row that carry no event before a request's stream is given up on. */
const MAX_IDLE_STREAM_RESUMES = 20

/** Where an SSE stream stopped: its last event id and `retry` hint, and how many events came. */
interface StreamCursor {
  events: number
  lastEventId?: string
  retryMs?: number
}

/** The wait before resuming a stream, from the server's `retry` hint (clamped). */
function resumeDelayMs(retryMs: number | undefined): number {
  if (retryMs === undefined || !Number.isFinite(retryMs)) return DEFAULT_RESUME_DELAY_MS
  return Math.min(MAX_RESUME_DELAY_MS, Math.max(MIN_RESUME_DELAY_MS, retryMs))
}

/** Wait `ms`, or less if `signal` aborts; true when the wait ran its course. */
function abortableDelay(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    timer.unref?.()
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

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
  /** Reopens of the notification stream since it was last healthy, for the backoff. */
  private streamReconnects = 0
  /** Where the notification stream last stopped, so a reopen resumes from there. */
  private notifyCursor: { lastEventId?: string; retryMs?: number } = {}
  /** Answers `elicitation/create`; its presence declares the capability. */
  /** The version agreed at initialize; set once the handshake answers. */
  private protocolVersion?: McpProtocolVersion
  private onElicit?: (params: unknown) => Promise<ElicitationWireResult>
  tools: McpToolInfo[] = []
  droppedTools: string[] = []
  listNotes: Partial<Record<McpListKind, string>> = {}
  resources: McpResourceInfo[] = []
  prompts: McpPromptInfo[] = []

  constructor(private readonly fetchFn: FetchFn = outboundFetch) {}

  get isClosed(): boolean {
    return this.closed
  }

  /** Perform the initialize handshake against the endpoint and list its tools. */
  async connect(opts: {
    url: string
    headers?: Record<string, string>
    onElicit?: (params: unknown) => Promise<ElicitationWireResult>
  }): Promise<void> {
    this.url = opts.url
    this.extraHeaders = opts.headers ?? {}
    this.onElicit = opts.onElicit
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
    this.openNotificationStream()
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

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const res = (await this.rpc('tools/call', { name, arguments: args ?? {} }, CALL_TIMEOUT_MS, {
      progress: true,
      signal
    })) as {
      content?: unknown
      isError?: boolean
    }
    const text = flattenMcpContent(res?.content)
    return res?.isError ? `${text}\n[the MCP tool reported an error]`.trim() : text || '[no output]'
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
    this.pending.failAll('MCP HTTP client closed')
    this.streamAbort?.abort()
  }

  // ---- transport internals ----

  private headers(): Record<string, string> {
    return {
      ...this.extraHeaders,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      // Required on every request after initialize, carrying the NEGOTIATED version;
      // the initialize POST itself goes without (nothing is agreed yet).
      ...(this.protocolVersion ? { 'mcp-protocol-version': this.protocolVersion } : {}),
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {})
    }
  }

  private async rpc(
    method: string,
    params: unknown,
    timeoutMs: number,
    opts: { progress?: boolean; signal?: AbortSignal } = {}
  ): Promise<unknown> {
    if (this.closed) throw new Error('MCP HTTP client is closed')
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
      // Dropping the response stream is not a cancel under streamable HTTP: the server
      // is told explicitly, on its own POST.
      onCancel: () => {
        if (!this.closed) void this.fireAndForget(cancelledNotification(id))
      }
    })
    const controller = new AbortController()
    // Stop the transfer once the request settles, whichever way: the response
    // arrived (no need to drain the rest), it timed out, was cancelled, or the client closed.
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
      const err = new McpUnauthorizedError(
        `MCP ${method} failed: HTTP 401 (the server rejected the credentials or requires OAuth sign-in)`,
        res.headers.get('www-authenticate')
      )
      // Credentials that stopped working (a revoked or silently expired token) won't
      // start working on this connection: mark it dead, like an expired session, so
      // the manager reconnects (refreshing the OAuth token) instead of reusing it.
      this.closed = true
      this.pending.reject(id, err)
      this.pending.failAll(err.message)
      return
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
      const cursor = await this.readEventStream(res.body)
      if (this.pending.has(id)) await this.resumeAfterClose(id, cursor, controller)
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
      // Replies to server requests (ping, elicitation, method-not-found) go out
      // as their own POST; the server acknowledges with a body-less 202.
      send: (payload) => void this.fireAndForget(payload),
      onListChanged: (kind) => this.refresher.schedule(kind),
      touchProgress: (token) => this.pending.touch(token),
      ...(this.onElicit
        ? { onElicit: (p: unknown) => keepAliveDuring(this.pending, () => this.onElicit!(p)) }
        : {})
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

  /**
   * Incrementally read an SSE body, dispatching each event as it arrives. Returns
   * where the stream stopped: the last event id and `retry` hint the server sent (a
   * server that closes a stream on purpose sends both, see {@link resumeAfterClose}),
   * and how many events arrived.
   */
  private async readEventStream(body: ReadableStream<Uint8Array>): Promise<StreamCursor> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    const buffer = new SseEventBuffer()
    const cursor: StreamCursor = { events: 0 }
    const emit = (events: SseEvent[]): void => {
      for (const e of events) {
        cursor.events++
        if (e.id !== undefined) cursor.lastEventId = e.id
        if (e.retry !== undefined) cursor.retryMs = e.retry
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
        emit(buffer.push(decoder.decode(value, { stream: true })))
      }
      // Some servers end the stream without a trailing blank line; flush the
      // remainder as a final event so that response isn't dropped.
      emit(buffer.finish(decoder.decode()))
    } catch {
      // Aborted (request settled / client closed) or the network dropped; any
      // still-pending request is settled by its own timers.
    }
    return cursor
  }

  /**
   * A request's response stream ended before its response. Since 2025-11-25 a server
   * may close a stream at will (to have the client poll) after sending an event id;
   * the client then resumes it with a GET carrying `Last-Event-ID`, after the
   * server's `retry` delay, and the server replays what followed. Resuming repeats
   * while the request is pending and the server keeps sending ids; the request's own
   * timeouts bound it, and so does a cap on resumes that bring nothing new. Returns
   * once the request settles or the stream can't be resumed.
   */
  private async resumeAfterClose(id: number, first: StreamCursor, controller: AbortController): Promise<void> {
    let cursor = first
    let idle = 0
    while (cursor.lastEventId !== undefined && this.pending.has(id) && !this.closed) {
      if (!(await abortableDelay(resumeDelayMs(cursor.retryMs), controller.signal))) return
      if (!this.pending.has(id) || this.closed) return
      const res = await this.fetchFn(this.url, {
        method: 'GET',
        headers: { ...this.streamHeaders(), 'last-event-id': cursor.lastEventId },
        signal: controller.signal
      })
      if (res.status === 404 && this.sessionId) {
        await res.text().catch(() => '')
        this.closed = true
        this.pending.failAll('MCP request failed: the server expired the session')
        return
      }
      if (!res.ok || !res.body || !(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
        await res.text().catch(() => '')
        return
      }
      const next = await this.readEventStream(res.body)
      idle = next.events > 0 ? 0 : idle + 1
      if (idle >= MAX_IDLE_STREAM_RESUMES) return
      cursor = {
        events: next.events,
        lastEventId: next.lastEventId ?? cursor.lastEventId,
        retryMs: next.retryMs ?? cursor.retryMs
      }
    }
  }

  /** Headers for a GET event stream (the notification stream, or a resume). */
  private streamHeaders(): Record<string, string> {
    return {
      ...this.extraHeaders,
      accept: 'text/event-stream',
      ...(this.protocolVersion ? { 'mcp-protocol-version': this.protocolVersion } : {}),
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {})
    }
  }

  /**
   * Hold the transport's optional GET event-stream open so server-initiated
   * messages (list_changed, pings) reach us between calls. Servers that don't
   * offer one answer 405 and lose nothing.
   *
   * The stream is reopened when it drops (a proxy's idle timeout, a server restart,
   * a network blip), with backoff, since otherwise every later notification was
   * lost until the whole connection was rebuilt. A reopened stream re-fetches the
   * declared lists, because a change announced while it was down never arrived.
   */
  private openNotificationStream(): void {
    if (this.closed) return
    const controller = new AbortController()
    this.streamAbort = controller
    void (async () => {
      let reopen = true
      try {
        const res = await this.fetchFn(this.url, {
          method: 'GET',
          headers: {
            ...this.streamHeaders(),
            // Resume where the last stream stopped: the server replays what it missed.
            ...(this.notifyCursor.lastEventId !== undefined ? { 'last-event-id': this.notifyCursor.lastEventId } : {})
          },
          signal: controller.signal
        })
        if (res.status === 404 && this.sessionId) {
          // The session expired (as on a POST): the manager reconnects from scratch.
          await res.text().catch(() => '')
          this.closed = true
          this.pending.failAll('MCP notification stream failed: the server expired the session')
          reopen = false
          return
        }
        if (!res.ok || !res.body || !(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
          // No stream on offer (405 and the like) is final; a server error may pass.
          await res.text().catch(() => '')
          reopen = res.status >= 500 || res.status === 429
          return
        }
        // A resumed stream replays what was missed; a fresh one can't, so re-fetch.
        if (this.streamReconnects > 0 && this.notifyCursor.lastEventId === undefined) {
          for (const kind of ['tools', 'resources', 'prompts'] as const) this.refresher.schedule(kind)
        }
        const openedAt = Date.now()
        const cursor = await this.readEventStream(res.body)
        if (cursor.lastEventId !== undefined) this.notifyCursor.lastEventId = cursor.lastEventId
        if (cursor.retryMs !== undefined) this.notifyCursor.retryMs = cursor.retryMs
        // A stream that stayed up a while was healthy, and one the server closed after
        // sending an id is polling on purpose: either way, start the backoff over.
        if (Date.now() - openedAt >= STREAM_HEALTHY_MS || cursor.lastEventId !== undefined) this.streamReconnects = 0
      } catch {
        // A network failure: reopen like a dropped stream.
      } finally {
        if (reopen) this.scheduleStreamReopen(controller)
      }
    })()
  }

  /** Reopen the notification stream after a backoff, unless the client closed meanwhile. */
  private scheduleStreamReopen(controller: AbortController): void {
    if (this.closed || controller.signal.aborted) return
    // A server's `retry` hint sets the first wait; failures after it still back off.
    const delay =
      this.streamReconnects === 0 && this.notifyCursor.retryMs !== undefined
        ? resumeDelayMs(this.notifyCursor.retryMs)
        : Math.min(STREAM_RETRY_MAX_MS, STREAM_RETRY_BASE_MS * 2 ** this.streamReconnects)
    this.streamReconnects++
    const timer = setTimeout(() => {
      if (!this.closed && !controller.signal.aborted) this.openNotificationStream()
    }, delay)
    timer.unref?.()
    controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
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
      const listed = await this.fetchList('tools')
      if (Array.isArray(listed?.tools)) this.setTools(listed)
    } else if (kind === 'resources') {
      this.resources = parseMcpResourceList(await this.fetchList('resources'))
    } else {
      this.prompts = parseMcpPromptList(await this.fetchList('prompts'))
    }
  }

  private async notify(method: string, params: unknown): Promise<void> {
    await this.fireAndForget({ jsonrpc: '2.0', method, params })
  }
}
