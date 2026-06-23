import { spawn as nodeSpawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { flattenMcpContent } from '@shared/mcp'

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

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
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
  private readonly pending = new Map<number, Pending>()
  private buffer = ''
  private closed = false
  tools: McpToolInfo[] = []

  constructor(private readonly spawnFn: SpawnFn = nodeSpawn as unknown as SpawnFn) {}

  /** Spawn the server, perform the initialize handshake, and list its tools. */
  async connect(opts: {
    command: string
    args?: string[]
    env?: NodeJS.ProcessEnv
    cwd?: string
  }): Promise<void> {
    const child = this.spawnFn(opts.command, opts.args ?? [], {
      env: { ...process.env, ...opts.env },
      cwd: opts.cwd
    })
    this.child = child
    child.stdout.on('data', (c: Buffer) => this.onData(c))
    child.on('exit', () => this.failAll('MCP server process exited'))
    child.on('error', (e: Error) => this.failAll(`MCP server failed to start: ${e.message}`))

    await this.request(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'Houston', version: '0.1.0' }
      },
      INIT_TIMEOUT_MS
    )
    this.notify('notifications/initialized', {})

    const listed = (await this.request('tools/list', {}, INIT_TIMEOUT_MS)) as {
      tools?: McpToolInfo[]
    }
    this.tools = Array.isArray(listed?.tools) ? listed.tools : []
  }

  /** Call a tool and return its flattened text result. */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const res = (await this.request(
      'tools/call',
      { name, arguments: args ?? {} },
      CALL_TIMEOUT_MS
    )) as { content?: unknown; isError?: boolean }
    const text = flattenMcpContent(res?.content)
    return res?.isError ? `${text}\n[the MCP tool reported an error]`.trim() : text || '[no output]'
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
    let msg: { id?: number; result?: unknown; error?: { message?: string } }
    try {
      msg = JSON.parse(line)
    } catch {
      return // ignore non-JSON noise
    }
    if (typeof msg.id !== 'number') return // server-initiated request/notification — unsupported, ignore
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    if (msg.error) p.reject(new Error(msg.error.message ?? 'MCP error'))
    else p.resolve(msg.result)
  }

  private send(obj: unknown): void {
    this.child?.stdin.write(`${JSON.stringify(obj)}\n`)
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params })
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('MCP client is closed'))
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
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
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  private failAll(message: string): void {
    for (const p of this.pending.values()) p.reject(new Error(message))
    this.pending.clear()
  }
}
