import { flattenMcpContent, flattenMcpResourceContents } from '@shared/mcp'
import {
  mcpResourcesCapable,
  parseMcpResourceList,
  type McpConnection,
  type McpResourceInfo,
  type McpToolInfo
} from './client'

/**
 * A minimal MCP client over the **streamable HTTP** transport (the remote
 * counterpart to the stdio client). It speaks JSON-RPC 2.0 by POSTing each
 * request to a single endpoint URL; the server replies with either a JSON body
 * or a `text/event-stream` (SSE) body carrying the JSON-RPC response. A
 * `Mcp-Session-Id` returned on initialize is echoed on later requests.
 *
 * Enough to initialize, list tools, and call them — covering hosted MCP servers
 * without pulling in the full SDK. Like the stdio client, tool calls are still
 * gated by the agent's approval flow (kind "mcp" always prompts).
 */

const PROTOCOL_VERSION = '2025-06-18'
const INIT_TIMEOUT_MS = 20_000
const CALL_TIMEOUT_MS = 120_000

interface JsonRpcMessage {
  id?: number
  result?: unknown
  error?: { message?: string }
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

/**
 * Find the JSON-RPC response for `id` in an HTTP body, handling both a plain
 * JSON body and an SSE body (possibly carrying several messages). Returns null
 * if nothing parseable matches.
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
  tools: McpToolInfo[] = []
  resources: McpResourceInfo[] = []

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

    // Only ask for resources when the server declared the capability.
    if (mcpResourcesCapable(init)) {
      try {
        this.resources = parseMcpResourceList(await this.rpc('resources/list', {}, INIT_TIMEOUT_MS))
      } catch {
        this.resources = []
      }
    }
  }

  /** Read a resource's contents by uri, flattened to text. */
  async readResource(uri: string): Promise<string> {
    const res = await this.rpc('resources/read', { uri }, CALL_TIMEOUT_MS)
    return flattenMcpResourceContents(res) || '[no content]'
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const res = (await this.rpc('tools/call', { name, arguments: args ?? {} }, CALL_TIMEOUT_MS)) as {
      content?: unknown
      isError?: boolean
    }
    const text = flattenMcpContent(res?.content)
    return res?.isError ? `${text}\n[the MCP tool reported an error]`.trim() : text || '[no output]'
  }

  close(): void {
    this.closed = true
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

  private async post(payload: unknown, timeoutMs: number): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await this.fetchFn(this.url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(payload),
        signal: controller.signal
      })
    } finally {
      clearTimeout(timer)
    }
  }

  private async rpc(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closed) throw new Error('MCP HTTP client is closed')
    const id = this.nextId++
    const res = await this.post({ jsonrpc: '2.0', id, method, params }, timeoutMs)
    const sid = res.headers.get('mcp-session-id')
    if (sid) this.sessionId = sid
    const text = await res.text()
    if (!res.ok && !text) throw new Error(`MCP ${method} failed: HTTP ${res.status}`)
    const msg = pickJsonRpc(res.headers.get('content-type') ?? '', text, id)
    if (!msg) {
      throw new Error(`MCP ${method} failed: HTTP ${res.status} — no JSON-RPC response`)
    }
    if (msg.error) throw new Error(msg.error.message ?? `MCP ${method} error`)
    return msg.result
  }

  private async notify(method: string, params: unknown): Promise<void> {
    try {
      const res = await this.post({ jsonrpc: '2.0', method, params }, INIT_TIMEOUT_MS)
      // Drain the body so the connection can be reused; ignore its content.
      await res.text().catch(() => '')
    } catch {
      // Notifications are best-effort; a server that ignores them is fine.
    }
  }
}
