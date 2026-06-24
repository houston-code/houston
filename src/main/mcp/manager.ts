import type { McpServerConfig } from '@shared/types'
import { mcpToolName } from '@shared/mcp'
import type { ToolDef } from '../agent/tools'
import { McpClient, type McpConnection } from './client'
import { McpHttpClient } from './http-client'
import { McpSseClient } from './sse-client'
import { log } from '../logger'

/**
 * Manages connections to the configured MCP servers and exposes their tools to
 * the agent as ToolDefs (namespaced, kind "mcp"). Connections are cached for the
 * app session and reused across runs; a server whose config changed is
 * reconnected, and one that's removed/disabled is closed. A server that fails to
 * connect is logged and skipped — it just contributes no tools. The stdio
 * (spawned process), streamable-HTTP, and legacy HTTP+SSE (remote URL) transports
 * are all supported.
 */

interface Connection {
  key: string
  client: McpConnection
}

const connections = new Map<string, Connection>()

/** Test seam: how stdio MCP clients are constructed (overridable in tests). */
let createClient: () => McpClient = () => new McpClient()
export function _setMcpClientFactory(factory: (() => McpClient) | null): void {
  createClient = factory ?? (() => new McpClient())
}

/** Test seam: how HTTP MCP clients are constructed (overridable in tests). */
let createHttpClient: () => McpHttpClient = () => new McpHttpClient()
export function _setMcpHttpClientFactory(factory: (() => McpHttpClient) | null): void {
  createHttpClient = factory ?? (() => new McpHttpClient())
}

/** Test seam: how SSE MCP clients are constructed (overridable in tests). */
let createSseClient: () => McpSseClient = () => new McpSseClient()
export function _setMcpSseClientFactory(factory: (() => McpSseClient) | null): void {
  createSseClient = factory ?? (() => new McpSseClient())
}

type Transport = 'stdio' | 'http' | 'sse'

/**
 * The transport a server uses: honor an explicit `transport`, else infer from the
 * shape — a `url` with no `command` means a remote server (streamable HTTP).
 */
function transportOf(c: McpServerConfig): Transport {
  if (c.transport === 'sse') return 'sse'
  if (c.transport === 'http') return 'http'
  if (c.transport === 'stdio') return 'stdio'
  return !c.command && c.url ? 'http' : 'stdio'
}

function configKey(c: McpServerConfig): string {
  return JSON.stringify([transportOf(c), c.command, c.args ?? [], c.url, c.headers ?? {}, c.enabled])
}

// Serialize reconciliation so overlapping runs can't interleave on the shared
// `connections` map (one run closing/replacing a connection mid-reconcile).
let ensureLock: Promise<void> = Promise.resolve()
function ensureConnections(configs: McpServerConfig[]): Promise<void> {
  ensureLock = ensureLock.catch(() => undefined).then(() => reconcileConnections(configs))
  return ensureLock
}

async function reconcileConnections(configs: McpServerConfig[]): Promise<void> {
  const enabled = configs.filter((c) => c.enabled && c.id && (c.command || c.url))
  const wanted = new Set(enabled.map((c) => c.id))

  // Close connections for servers that are gone or disabled.
  for (const [id, conn] of connections) {
    if (!wanted.has(id)) {
      conn.client.close()
      connections.delete(id)
    }
  }

  for (const c of enabled) {
    const existing = connections.get(c.id)
    const key = configKey(c)
    // Reuse only a live connection with the same config; reconnect if the config
    // changed or the cached client has since died (so calls don't hang on it).
    if (existing && existing.key === key && !existing.client.isClosed) continue
    if (existing) existing.client.close()
    const transport = transportOf(c)
    const client: McpConnection =
      transport === 'http' ? createHttpClient() : transport === 'sse' ? createSseClient() : createClient()
    try {
      if (transport === 'http') await (client as McpHttpClient).connect({ url: c.url ?? '', headers: c.headers })
      else if (transport === 'sse') await (client as McpSseClient).connect({ url: c.url ?? '', headers: c.headers })
      else await (client as McpClient).connect({ command: c.command, args: c.args })
      connections.set(c.id, { key, client })
    } catch (e) {
      client.close()
      connections.delete(c.id)
      log.warn(`MCP server "${c.id}" failed to connect: ${(e as Error).message}`)
    }
  }
}

/** Connect the configured servers (best effort) and return their tools as ToolDefs. */
export async function getMcpToolDefs(configs: McpServerConfig[] | undefined): Promise<ToolDef[]> {
  // Reconcile even with no configs when connections are still open, so removing
  // (or disabling) every server actually closes them instead of leaking to quit.
  if (!configs?.length && connections.size === 0) return []
  await ensureConnections(configs ?? [])

  const defs: ToolDef[] = []
  for (const [serverId, conn] of connections) {
    for (const t of conn.client.tools) {
      const fullName = mcpToolName(serverId, t.name)
      const original = t.name
      defs.push({
        kind: 'mcp',
        summarize: () => `${serverId}: ${original}`,
        schema: {
          name: fullName,
          description: t.description ?? `MCP tool "${original}" from server "${serverId}".`,
          parameters:
            t.inputSchema && typeof t.inputSchema === 'object'
              ? t.inputSchema
              : { type: 'object', properties: {} }
        },
        // Resolve the live connection at call time so a reconnect (or removal)
        // between building the tool list and the call doesn't hit a stale client.
        execute: (args) => {
          const live = connections.get(serverId)
          if (!live) return Promise.resolve(`[MCP server "${serverId}" is no longer connected]`)
          return live.client.callTool(original, args)
        }
      })
    }
  }
  return defs
}

/** Close every MCP connection (wired on app shutdown). */
export function disconnectAllMcp(): void {
  for (const conn of connections.values()) conn.client.close()
  connections.clear()
}
