import type { McpServerConfig } from './types'
import { sanitizeServerId } from './mcp'

/**
 * Read MCP server definitions written in the common JSON shapes other tools and
 * server READMEs use, into Houston's own {@link McpServerConfig}. Accepted:
 *
 *  - `{ "mcpServers": { "<name>": { command, args, env, cwd, url, headers, type } } }`
 *  - `{ "servers": { "<name>": { ... } } }` (the same map under another key)
 *  - the bare map itself, `{ "<name>": { ... } }`, as pasted from a README
 *  - Houston's own array form, `{ "mcpServers": [{ "id": ..., ... }] }`
 *
 * Pure and defensive: the input is untrusted text. Ids are sanitized to the
 * namespacing-safe charset, every field is type-checked, an entry with neither a
 * command nor a URL is reported rather than kept, and nothing here runs anything.
 */

/** Most servers one paste or one file may define. */
export const MAX_MCP_JSON_SERVERS = 50

export interface McpJsonResult {
  servers: McpServerConfig[]
  /** Entries that could not be read, as `name: reason`. */
  problems: string[]
}

function stringMap(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') out[k] = String(val)
  }
  return Object.keys(out).length ? out : undefined
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** One entry of a server map (or array) as a config, or a reason it can't be. */
export function mcpServerFromJson(name: string, raw: unknown): McpServerConfig | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'not an object'
  const v = raw as Record<string, unknown>
  const id = sanitizeServerId(name)
  if (!id) return 'needs a name made of letters, digits, - or _'
  const command = str(v.command)
  // Remote endpoints appear as `url`, `serverUrl` or `httpUrl` depending on who wrote the file.
  const url = str(v.url) || str(v.serverUrl) || str(v.httpUrl)
  if (!command && !url) return 'needs a "command" or a "url"'
  if (url && !command && !/^https?:\/\//i.test(url)) return 'the url must start with http:// or https://'
  const type = str(v.type ?? v.transport).toLowerCase()
  const transport: McpServerConfig['transport'] = command ? 'stdio' : type === 'sse' ? 'sse' : 'http'
  const args = Array.isArray(v.args) ? v.args.filter((a): a is string => typeof a === 'string') : []
  const env = command ? stringMap(v.env) : undefined
  const headers = command ? undefined : stringMap(v.headers)
  const cwd = command ? str(v.cwd) : ''
  return {
    id,
    transport,
    command,
    ...(command ? { args } : {}),
    ...(cwd ? { cwd } : {}),
    ...(env ? { env } : {}),
    ...(url && !command ? { url } : {}),
    ...(headers ? { headers } : {}),
    enabled: true
  }
}

/** The server map or list a parsed JSON value holds, whichever shape it uses. */
function serverEntries(raw: unknown): Array<[string, unknown]> | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const inner = obj.mcpServers ?? obj.servers ?? obj.mcp_servers
  const source = inner === undefined ? raw : inner
  if (Array.isArray(source)) {
    return source.map((s, i): [string, unknown] => {
      const o = s && typeof s === 'object' ? (s as Record<string, unknown>) : {}
      const id = typeof o.id === 'string' ? o.id : typeof o.name === 'string' ? o.name : `server-${i + 1}`
      return [id, s]
    })
  }
  if (!source || typeof source !== 'object') return null
  const entries = Object.entries(source as Record<string, unknown>)
  // A bare map must look like one: every value an object. Anything else (a settings
  // file with no servers in it) holds no servers rather than a list of broken ones.
  if (inner === undefined && !entries.every(([, v]) => v && typeof v === 'object' && !Array.isArray(v))) return null
  return entries
}

/** Servers from an already-parsed JSON value. Duplicate ids keep the first. */
export function mcpServersFromJson(raw: unknown): McpJsonResult {
  const entries = serverEntries(raw)
  if (!entries) return { servers: [], problems: [] }
  const servers: McpServerConfig[] = []
  const problems: string[] = []
  for (const [name, value] of entries) {
    if (servers.length >= MAX_MCP_JSON_SERVERS) {
      problems.push(`only the first ${MAX_MCP_JSON_SERVERS} servers are read`)
      break
    }
    const parsed = mcpServerFromJson(name, value)
    if (typeof parsed === 'string') problems.push(`${name}: ${parsed}`)
    else if (servers.some((s) => s.id === parsed.id)) problems.push(`${name}: the name "${parsed.id}" is used twice`)
    else servers.push(parsed)
  }
  return { servers, problems }
}

/** Servers from JSON text, or an error when the text is not JSON or holds no servers. */
export function parseMcpServersJson(text: string): McpJsonResult | { error: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return { error: `Not valid JSON: ${(e as Error).message}` }
  }
  const result = mcpServersFromJson(raw)
  if (result.servers.length === 0 && result.problems.length === 0) {
    return { error: 'No servers found. Paste an object with an "mcpServers" map.' }
  }
  return result
}
