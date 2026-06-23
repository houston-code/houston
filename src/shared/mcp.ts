/**
 * Pure helpers for the Model Context Protocol (MCP) integration. MCP tools are
 * namespaced so they can't collide with Houston's built-in tools or each other:
 * `mcp__<serverId>__<toolName>`. The server id is constrained to [\w-]+, so the
 * boundary is unambiguous.
 */

const MCP_PREFIX = 'mcp__'

/** Namespaced tool name for an MCP server's tool. */
export function mcpToolName(serverId: string, toolName: string): string {
  return `${MCP_PREFIX}${serverId}__${toolName}`
}

/**
 * Parse a namespaced MCP tool name back into its server id and original tool name.
 * The server id capture is non-greedy so the FIRST `__` after the prefix is the
 * boundary — server ids never contain `__` (see sanitizeServerId), so the rest,
 * which may itself contain `__`, is the tool name.
 */
export function parseMcpToolName(name: string): { serverId: string; toolName: string } | null {
  const m = /^mcp__([\w-]+?)__(.+)$/.exec(name)
  return m ? { serverId: m[1], toolName: m[2] } : null
}

/** Whether a tool name belongs to an MCP server. */
export function isMcpToolName(name: string): boolean {
  return parseMcpToolName(name) !== null
}

/**
 * Sanitize a user-supplied server id to the namespacing-safe charset. Collapses
 * `__` to `_` so the id can never contain the `__` boundary delimiter.
 */
export function sanitizeServerId(id: string): string {
  return id
    .trim()
    .replace(/[^\w-]+/g, '-')
    .replace(/_{2,}/g, '_')
    .replace(/^-+|-+$/g, '')
}

interface ContentBlock {
  type?: string
  text?: string
}

/**
 * Flatten an MCP tool result's `content` array into plain text for the agent.
 * Text blocks are concatenated; non-text blocks are noted by type.
 */
export function flattenMcpContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return typeof content === 'string' ? content : ''
  }
  const parts: string[] = []
  for (const block of content as ContentBlock[]) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    } else if (block && typeof block === 'object' && typeof block.type === 'string') {
      parts.push(`[${block.type} content]`)
    }
  }
  return parts.join('\n').trim()
}
