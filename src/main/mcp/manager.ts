import type { McpServerConfig } from '@shared/types'
import { mcpToolName } from '@shared/mcp'
import type { ToolDef } from '../agent/tools'
import { McpClient } from './client'

/**
 * Manages connections to the configured MCP servers and exposes their tools to
 * the agent as ToolDefs (namespaced, kind "mcp"). Connections are cached for the
 * app session and reused across runs; a server whose config changed is
 * reconnected, and one that's removed/disabled is closed. A server that fails to
 * connect is logged and skipped — it just contributes no tools.
 */

interface Connection {
  key: string
  client: McpClient
}

const connections = new Map<string, Connection>()

function configKey(c: McpServerConfig): string {
  return JSON.stringify([c.command, c.args ?? [], c.enabled])
}

async function ensureConnections(configs: McpServerConfig[]): Promise<void> {
  const enabled = configs.filter((c) => c.enabled && c.command && c.id)
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
    if (existing && existing.key === key) continue
    if (existing) existing.client.close()
    const client = new McpClient()
    try {
      await client.connect({ command: c.command, args: c.args })
      connections.set(c.id, { key, client })
    } catch (e) {
      client.close()
      connections.delete(c.id)
      console.warn(`[mcp] server "${c.id}" failed to connect: ${(e as Error).message}`)
    }
  }
}

/** Connect the configured servers (best effort) and return their tools as ToolDefs. */
export async function getMcpToolDefs(configs: McpServerConfig[] | undefined): Promise<ToolDef[]> {
  if (!configs?.length) return []
  await ensureConnections(configs)

  const defs: ToolDef[] = []
  for (const [serverId, conn] of connections) {
    for (const t of conn.client.tools) {
      const fullName = mcpToolName(serverId, t.name)
      const client = conn.client
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
        execute: (args) => client.callTool(original, args)
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
