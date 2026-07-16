import { spawn as nodeSpawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { flattenMcpContent, flattenMcpPromptMessages, flattenMcpResourceContents } from '@shared/mcp'
import { sanitizeChildEnv } from '../childEnv'
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
 * A minimal MCP client over the stdio transport: it spawns the server process and
 * speaks JSON-RPC 2.0 as newline-delimited JSON on stdin/stdout (the MCP stdio
 * framing). Enough to initialize, list tools, and call them — which covers the
 * common local servers (filesystem, git, etc.) without pulling in a heavy SDK.
 *
 * MCP servers are user-configured trusted commands; they run as normal child
 * processes (not in the Seatbelt sandbox). Their tool calls are still gated by
 * the agent's approval flow (kind "mcp" always prompts).
 */

export interface McpToolInfo {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

/** A resource an MCP server exposes (addressed by uri), from `resources/list`. */
export interface McpResourceInfo {
  uri: string
  name?: string
  description?: string
  mimeType?: string
}

/**
 * HTTP 401 from a remote MCP server — the typed signal that the request lacked
 * (valid) credentials. The manager catches it to refresh an expired OAuth access
 * token and retry, or to tell the user the server needs an OAuth sign-in.
 */
export class McpUnauthorizedError extends Error {
  constructor(
    message: string,
    /** The response's WWW-Authenticate challenge, when present. */
    readonly wwwAuthenticate: string | null = null
  ) {
    super(message)
    this.name = 'McpUnauthorizedError'
  }
}

/** A prompt template an MCP server exposes, from `prompts/list`. */
export interface McpPromptInfo {
  name: string
  description?: string
  arguments?: Array<{ name: string; description?: string; required?: boolean }>
}

/**
 * The transport-agnostic surface the manager uses. Implemented by McpClient
 * (stdio), McpHttpClient (streamable HTTP), and McpSseClient so the manager can
 * treat them uniformly once connected. The `tools`/`resources`/`prompts` lists
 * are kept current in place when the server sends `list_changed` notifications.
 */
export interface McpConnection {
  readonly tools: McpToolInfo[]
  /** Resources the server exposes; empty when the server doesn't support them. */
  readonly resources: McpResourceInfo[]
  /** Prompt templates the server exposes; empty when it doesn't support them. */
  readonly prompts: McpPromptInfo[]
  readonly isClosed: boolean
  callTool(name: string, args: Record<string, unknown>): Promise<string>
  /** Read a resource's contents by uri (flattened to text). */
  readResource(uri: string): Promise<string>
  /** Fetch a prompt template by name (flattened to text). */
  getPrompt(name: string, args: Record<string, string>): Promise<string>
  close(): void
}

/** True if a server's initialize result declared the given capability. */
export function mcpCapable(initResult: unknown, capability: 'resources' | 'prompts'): boolean {
  if (!initResult || typeof initResult !== 'object') return false
  const caps = (initResult as { capabilities?: unknown }).capabilities
  return !!caps && typeof caps === 'object' && capability in (caps as object)
}

/** True if a server's initialize result declared the `resources` capability. */
export function mcpResourcesCapable(initResult: unknown): boolean {
  return mcpCapable(initResult, 'resources')
}

/** Parse a `prompts/list` result into prompt descriptors (drops malformed entries). */
export function parseMcpPromptList(result: unknown): McpPromptInfo[] {
  if (!result || typeof result !== 'object') return []
  const list = (result as { prompts?: unknown }).prompts
  if (!Array.isArray(list)) return []
  const out: McpPromptInfo[] = []
  for (const p of list) {
    if (!p || typeof p !== 'object') continue
    const item = p as Record<string, unknown>
    if (typeof item.name !== 'string') continue
    const args = Array.isArray(item.arguments)
      ? (item.arguments as Array<Record<string, unknown>>)
          .filter((a) => a && typeof a.name === 'string')
          .map((a) => ({
            name: a.name as string,
            ...(typeof a.description === 'string' ? { description: a.description } : {}),
            ...(typeof a.required === 'boolean' ? { required: a.required } : {})
          }))
      : undefined
    out.push({
      name: item.name,
      ...(typeof item.description === 'string' ? { description: item.description } : {}),
      ...(args?.length ? { arguments: args } : {})
    })
  }
  return out
}

/** Parse a `resources/list` result into resource descriptors (drops malformed entries). */
export function parseMcpResourceList(result: unknown): McpResourceInfo[] {
  if (!result || typeof result !== 'object') return []
  const list = (result as { resources?: unknown }).resources
  if (!Array.isArray(list)) return []
  const out: McpResourceInfo[] = []
  for (const r of list) {
    if (!r || typeof r !== 'object') continue
    const item = r as Record<string, unknown>
    if (typeof item.uri !== 'string') continue
    out.push({
      uri: item.uri,
      ...(typeof item.name === 'string' ? { name: item.name } : {}),
      ...(typeof item.description === 'string' ? { description: item.description } : {}),
      ...(typeof item.mimeType === 'string' ? { mimeType: item.mimeType } : {})
    })
  }
  return out
}

const PROTOCOL_VERSION = '2024-11-05'
const INIT_TIMEOUT_MS = 15_000
const CALL_TIMEOUT_MS = 120_000

export type SpawnFn = (
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string }
) => ChildProcessWithoutNullStreams

export class McpClient {
  private child?: ChildProcessWithoutNullStreams
  private nextId = 1
  private readonly pending = new PendingRequests()
  private buffer = ''
  private closed = false
  /** Capabilities the server declared at initialize (gates list re-fetches). */
  private capable: Record<McpListKind, boolean> = { tools: true, resources: false, prompts: false }
  private readonly refresher = new ListRefresher({
    isClosed: () => this.closed,
    capable: (kind) => this.capable[kind],
    fetch: (kind) => this.refreshList(kind)
  })
  tools: McpToolInfo[] = []
  resources: McpResourceInfo[] = []
  prompts: McpPromptInfo[] = []

  constructor(private readonly spawnFn: SpawnFn = nodeSpawn as unknown as SpawnFn) {}

  /** True once the process exited, errored, or the client was closed. */
  get isClosed(): boolean {
    return this.closed
  }

  /** Answers `elicitation/create`; its presence declares the capability. */
  private onElicit?: (params: unknown) => Promise<ElicitationWireResult>

  /** Spawn the server, perform the initialize handshake, and list its tools. */
  async connect(opts: {
    command: string
    args?: string[]
    env?: NodeJS.ProcessEnv
    cwd?: string
    onElicit?: (params: unknown) => Promise<ElicitationWireResult>
  }): Promise<void> {
    this.onElicit = opts.onElicit
    const child = this.spawnFn(opts.command, opts.args ?? [], {
      // Strip the launching shell's credential-bearing vars so a malicious or
      // compromised MCP server can't harvest ambient secrets (AWS keys, GH_TOKEN,
      // *_API_KEY, …) on startup. A server that legitimately needs a token still
      // gets it: `opts.env` (from McpServerConfig.env) is applied AFTER the strip.
      env: { ...sanitizeChildEnv(), ...opts.env },
      cwd: opts.cwd
    })
    this.child = child
    child.stdout.on('data', (c: Buffer) => this.onData(c))
    child.on('exit', () => this.failAll('MCP server process exited'))
    child.on('error', (e: Error) => this.failAll(`MCP server failed to start: ${e.message}`))

    const init = await this.request(
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
    this.notify('notifications/initialized', {})

    const listed = (await this.request('tools/list', {}, INIT_TIMEOUT_MS)) as {
      tools?: McpToolInfo[]
    }
    this.tools = Array.isArray(listed?.tools) ? listed.tools : []

    // Only ask for resources/prompts when the server declared the capability —
    // avoids an unsupported-method error (or a hang) against servers without them.
    this.capable.resources = mcpCapable(init, 'resources')
    this.capable.prompts = mcpCapable(init, 'prompts')
    if (this.capable.resources) {
      try {
        this.resources = parseMcpResourceList(
          await this.request('resources/list', {}, INIT_TIMEOUT_MS)
        )
      } catch {
        this.resources = []
      }
    }
    if (this.capable.prompts) {
      try {
        this.prompts = parseMcpPromptList(await this.request('prompts/list', {}, INIT_TIMEOUT_MS))
      } catch {
        this.prompts = []
      }
    }
  }

  /** Call a tool and return its flattened text result. */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const res = (await this.request(
      'tools/call',
      { name, arguments: args ?? {} },
      CALL_TIMEOUT_MS,
      { progress: true }
    )) as { content?: unknown; isError?: boolean }
    const text = flattenMcpContent(res?.content)
    return res?.isError ? `${text}\n[the MCP tool reported an error]`.trim() : text || '[no output]'
  }

  /** Read a resource's contents by uri, flattened to text. */
  async readResource(uri: string): Promise<string> {
    const res = await this.request('resources/read', { uri }, CALL_TIMEOUT_MS)
    return flattenMcpResourceContents(res) || '[no content]'
  }

  /** Fetch a prompt template by name, flattened to text. */
  async getPrompt(name: string, args: Record<string, string>): Promise<string> {
    const res = await this.request('prompts/get', { name, arguments: args ?? {} }, CALL_TIMEOUT_MS)
    return flattenMcpPromptMessages(res) || '[no content]'
  }

  close(): void {
    this.closed = true
    this.failAll('MCP client closed')
    this.child?.kill()
  }

  // ---- transport internals ----

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8')
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim()
      this.buffer = this.buffer.slice(nl + 1)
      if (line) this.handleLine(line)
    }
  }

  /** Process one newline-delimited JSON-RPC message. Exposed for testing. */
  handleLine(line: string): void {
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      return // ignore non-JSON noise
    }
    const msg = parseIncoming(raw)
    if (!msg) return
    if (kindOf(msg) === 'response') {
      this.pending.settle(msg.id as number | string, msg)
      return
    }
    handleServerMessage(msg, {
      send: (payload) => {
        try {
          this.send(payload)
        } catch {
          // Replying is best-effort; a broken pipe surfaces via 'exit'/'error'.
        }
      },
      onListChanged: (kind) => this.refresher.schedule(kind),
      touchProgress: (token) => this.pending.touch(token),
      ...(this.onElicit
        ? { onElicit: (p: unknown) => keepAliveDuring(this.pending, () => this.onElicit!(p)) }
        : {})
    })
  }

  /** Re-fetch one changed list in place (driven by the ListRefresher). */
  private async refreshList(kind: McpListKind): Promise<void> {
    if (kind === 'tools') {
      const listed = (await this.request('tools/list', {}, INIT_TIMEOUT_MS)) as { tools?: McpToolInfo[] }
      this.tools = Array.isArray(listed?.tools) ? listed.tools : this.tools
    } else if (kind === 'resources') {
      this.resources = parseMcpResourceList(await this.request('resources/list', {}, INIT_TIMEOUT_MS))
    } else {
      this.prompts = parseMcpPromptList(await this.request('prompts/list', {}, INIT_TIMEOUT_MS))
    }
  }

  private send(obj: unknown): void {
    this.child?.stdin.write(`${JSON.stringify(obj)}\n`)
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params })
  }

  private request(
    method: string,
    params: unknown,
    timeoutMs: number,
    opts: { progress?: boolean } = {}
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('MCP client is closed'))
    const id = this.nextId++
    // Ask for progress on long calls: a server that reports it keeps the call's
    // inactivity clock (see PendingRequests) from expiring mid-work.
    const sent = opts.progress
      ? { ...(params as Record<string, unknown>), _meta: { progressToken: id } }
      : params
    const result = this.pending.wait(id, method, timeoutMs)
    try {
      this.send({ jsonrpc: '2.0', id, method, params: sent })
    } catch (e) {
      // A synchronous write failure (e.g. EPIPE on a closing pipe) must settle the
      // pending entry + timers; reject does both.
      this.pending.reject(id, e as Error)
    }
    return result
  }

  private failAll(message: string): void {
    // A process that exited/errored (or an explicit close) can never answer again —
    // mark the client closed so later request()s reject immediately instead of
    // hanging until the call timeout on a dead server.
    this.closed = true
    this.pending.failAll(message)
  }
}
