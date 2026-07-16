/**
 * Pure helpers for the Model Context Protocol (MCP) integration. MCP tools are
 * namespaced so they can't collide with Houston's built-in tools or each other:
 * `mcp__<serverId>__<toolName>`. The server id is constrained to [\w-]+, so the
 * boundary is unambiguous.
 */

import type { ElicitationField, ElicitationResult } from './agent'

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

/**
 * Parse a textarea of "Name: value" lines into an HTTP headers map. Blank lines
 * and lines without a colon are skipped; keys/values are trimmed.
 */
export function parseHeaderLines(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    if (key) out[key] = line.slice(idx + 1).trim()
  }
  return out
}

// ---- Elicitation (server asks the user for input mid-call) ----

/**
 * Parse an elicitation `requestedSchema` (the MCP spec's flat object-of-primitives
 * subset of JSON Schema) into renderable field descriptors. Defensive at the trust
 * boundary: a missing/foreign schema yields [] (a message-only confirmation), and
 * an exotic property type degrades to a plain string input rather than failing.
 */
export function parseElicitationFields(schema: unknown): ElicitationField[] {
  if (!schema || typeof schema !== 'object') return []
  const props = (schema as { properties?: unknown }).properties
  if (!props || typeof props !== 'object') return []
  const required = (schema as { required?: unknown }).required
  const requiredSet = new Set(Array.isArray(required) ? required.filter((r) => typeof r === 'string') : [])
  const fields: ElicitationField[] = []
  for (const [name, raw] of Object.entries(props as Record<string, unknown>)) {
    const p = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    const enumValues = Array.isArray(p.enum) ? p.enum.filter((v) => typeof v === 'string') : []
    const kind: ElicitationField['kind'] = enumValues.length
      ? 'enum'
      : p.type === 'number' || p.type === 'integer' || p.type === 'boolean'
        ? p.type
        : 'string'
    fields.push({
      name,
      kind,
      ...(typeof p.title === 'string' ? { title: p.title } : {}),
      ...(typeof p.description === 'string' ? { description: p.description } : {}),
      ...(requiredSet.has(name) ? { required: true } : {}),
      ...(enumValues.length ? { options: enumValues } : {}),
      ...(typeof p.format === 'string' ? { format: p.format } : {})
    })
  }
  return fields
}

/**
 * Turn raw per-field user input (strings, as a form/terminal collects them) into
 * a typed elicitation `content` map, or a per-field error message. Booleans accept
 * y/yes/true/1 and n/no/false/0; enums must match an allowed value; a blank
 * optional field is omitted, a blank required field is an error.
 */
export function buildElicitationContent(
  fields: ElicitationField[],
  raw: Record<string, string>
): { content: NonNullable<ElicitationResult['content']> } | { error: string } {
  const content: NonNullable<ElicitationResult['content']> = {}
  for (const f of fields) {
    const value = (raw[f.name] ?? '').trim()
    if (!value) {
      if (f.required) return { error: `"${f.name}" is required.` }
      continue
    }
    if (f.kind === 'number' || f.kind === 'integer') {
      const n = Number(value)
      if (!Number.isFinite(n)) return { error: `"${f.name}" must be a number.` }
      if (f.kind === 'integer' && !Number.isInteger(n)) return { error: `"${f.name}" must be an integer.` }
      content[f.name] = n
    } else if (f.kind === 'boolean') {
      if (/^(y|yes|true|1)$/i.test(value)) content[f.name] = true
      else if (/^(n|no|false|0)$/i.test(value)) content[f.name] = false
      else return { error: `"${f.name}" must be yes or no.` }
    } else if (f.kind === 'enum') {
      const match = f.options?.find((o) => o === value) ?? f.options?.find((o) => o.toLowerCase() === value.toLowerCase())
      if (!match) return { error: `"${f.name}" must be one of: ${f.options?.join(', ')}.` }
      content[f.name] = match
    } else {
      content[f.name] = value
    }
  }
  return { content }
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

/**
 * Flatten an MCP `prompts/get` result into plain text for the agent: the prompt
 * description (when present) followed by each message as `role: text`. Non-text
 * message content is noted by type, mirroring {@link flattenMcpContent}.
 */
export function flattenMcpPromptMessages(result: unknown): string {
  if (!result || typeof result !== 'object') return ''
  const { description, messages } = result as { description?: unknown; messages?: unknown }
  const parts: string[] = []
  if (typeof description === 'string' && description.trim()) parts.push(description.trim())
  if (Array.isArray(messages)) {
    for (const m of messages) {
      if (!m || typeof m !== 'object') continue
      const { role, content } = m as { role?: unknown; content?: unknown }
      const text = flattenMcpContent(Array.isArray(content) ? content : [content])
      if (text) parts.push(`${typeof role === 'string' ? role : 'user'}: ${text}`)
    }
  }
  return parts.join('\n\n').trim()
}

/**
 * Flatten an MCP `resources/read` result's `contents` array into plain text.
 * Text contents are concatenated; a binary (base64 `blob`) content is noted with
 * its uri/mime rather than dumped, so a large binary can't flood the context.
 */
export function flattenMcpResourceContents(result: unknown): string {
  if (!result || typeof result !== 'object') return ''
  const contents = (result as { contents?: unknown }).contents
  if (!Array.isArray(contents)) return ''
  const parts: string[] = []
  for (const c of contents) {
    if (!c || typeof c !== 'object') continue
    const item = c as { text?: unknown; blob?: unknown; mimeType?: unknown; uri?: unknown }
    if (typeof item.text === 'string') {
      parts.push(item.text)
    } else if (typeof item.blob === 'string') {
      const uri = typeof item.uri === 'string' ? item.uri : ''
      const mime = typeof item.mimeType === 'string' ? item.mimeType : 'application/octet-stream'
      parts.push(`[binary resource ${uri} (${mime}), ${item.blob.length} base64 chars]`.replace(/\s+/g, ' '))
    }
  }
  return parts.join('\n').trim()
}
