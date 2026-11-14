import { createHash } from 'node:crypto'
import { mcpToolName } from '@shared/mcp'
import type { McpToolInfo } from './client'

/**
 * How an MCP server's tools are offered to a model provider.
 *
 * The MCP spec lets a server name a tool almost anything (`files.read`, a 70-char
 * name, two tools with one name) and give it any input schema, but providers reject
 * the WHOLE request when one tool breaks their rules: Anthropic wants names matching
 * `^[a-zA-Z0-9_-]{1,128}$`, OpenAI caps them at 64 characters, and both want an
 * object schema. One such tool used to fail every turn of every chat until the
 * server was turned off. Here each tool gets a provider-safe exposed name and an
 * object schema, while calls still send the server its own name.
 */

/** The longest exposed name: OpenAI's limit, the strictest of the providers. */
export const MAX_EXPOSED_NAME = 64

/** A schema serialized past this many characters is replaced (see {@link normalizeMcpInputSchema}). */
export const MAX_SCHEMA_CHARS = 32_000

/** A description longer than this is cut. */
const MAX_DESCRIPTION_CHARS = 8_000

const SAFE_NAME = /^[A-Za-z0-9_-]+$/

/** One tool as offered to the model. */
export interface ExposedMcpTool {
  /** The provider-facing name, `mcp__<server>__<tool>` unless it had to be rewritten. */
  name: string
  /** The name the server gave the tool, sent back on a call. */
  original: string
  description: string
  parameters: Record<string, unknown>
}

function shortHash(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 8)
}

/**
 * Whether `name` is already usable as is. A tool part that starts or ends with `_`
 * is not: `mcp__a___x` (server `a`, tool `_x`) reads as server `a_`'s tool `x` to a
 * permission rule, so a rule written for one server could cover another's tool.
 */
function usableAsIs(server: string, tool: string): boolean {
  return (
    SAFE_NAME.test(tool) &&
    !tool.startsWith('_') &&
    !tool.endsWith('_') &&
    mcpToolName(server, tool).length <= MAX_EXPOSED_NAME
  )
}

/** A rewritten exposed name for `tool`, with a hash suffix when `withHash` (always unique per original). */
function rewrittenName(server: string, tool: string, withHash: boolean): string {
  const cleaned = tool.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '') || 'tool'
  const prefix = mcpToolName(server, '')
  const plain = prefix + cleaned
  if (!withHash && plain.length <= MAX_EXPOSED_NAME) return plain
  const suffix = `_${shortHash(server, tool)}`
  const room = MAX_EXPOSED_NAME - prefix.length - suffix.length
  // A server id so long it leaves no room is shortened too (it is already [\w-], no `__`).
  if (room < 8) {
    const shortServer = `${server.slice(0, 20).replace(/_+$/, '')}_${shortHash(server)}`
    return rewrittenName(shortServer, tool, true)
  }
  return prefix + cleaned.slice(0, room).replace(/_+$/, '') + suffix
}

/**
 * The provider-safe tools for each server, in server and listing order. A name that is
 * already usable keeps its exact `mcp__<server>__<tool>` form, so permission rules and
 * saved approvals written for it keep working. A rewritten name never takes one that
 * an unchanged name holds: when two tools would map to one name, each rewritten one
 * gets a hash of its original name. An exact duplicate of a name already listed by the
 * same server is dropped. `report` hears each dropped or rewritten tool.
 */
export function exposeMcpTools(
  servers: Array<{ serverId: string; tools: readonly McpToolInfo[] }>,
  report: (serverId: string, problem: string) => void = () => {}
): Array<{ serverId: string; tools: ExposedMcpTool[] }> {
  return servers.map(({ serverId, tools }) => {
    const seenOriginal = new Set<string>()
    const unique: McpToolInfo[] = []
    for (const t of tools) {
      if (seenOriginal.has(t.name)) {
        report(serverId, `lists the tool "${t.name}" more than once; only the first is used`)
        continue
      }
      seenOriginal.add(t.name)
      unique.push(t)
    }
    // Unchanged names claim theirs first, so listing order can't change who gets which.
    const taken = new Set(unique.filter((t) => usableAsIs(serverId, t.name)).map((t) => mcpToolName(serverId, t.name)))
    const plainCounts = new Map<string, number>()
    for (const t of unique) {
      if (usableAsIs(serverId, t.name)) continue
      const plain = rewrittenName(serverId, t.name, false)
      plainCounts.set(plain, (plainCounts.get(plain) ?? 0) + 1)
    }
    const exposed = unique.map((t): ExposedMcpTool => {
      let name: string
      if (usableAsIs(serverId, t.name)) {
        name = mcpToolName(serverId, t.name)
      } else {
        const plain = rewrittenName(serverId, t.name, false)
        const clash = taken.has(plain) || (plainCounts.get(plain) ?? 0) > 1
        name = clash ? rewrittenName(serverId, t.name, true) : plain
        report(serverId, `tool "${t.name}" is offered to the model as "${name}"`)
      }
      const { parameters, note } = normalizeMcpInputSchema(t.inputSchema)
      if (note) report(serverId, `tool "${t.name}": ${note}`)
      const base = (t.description ?? `MCP tool "${t.name}" from server "${serverId}".`).slice(0, MAX_DESCRIPTION_CHARS)
      return {
        name,
        original: t.name,
        description: note ? `${base}\n\n(Houston: ${note}.)` : base,
        parameters
      }
    })
    return { serverId, tools: exposed }
  })
}

/**
 * An input schema every provider accepts at the top level: `type: 'object'` with an
 * object `properties`. Top-level combinators are folded in (the properties of every
 * `allOf`/`anyOf`/`oneOf` branch; `allOf` also merges `required`), since providers
 * reject them there. A schema too large to send is replaced by an open object schema,
 * and `note` says so.
 */
export function normalizeMcpInputSchema(schema: Record<string, unknown> | undefined): {
  parameters: Record<string, unknown>
  note?: string
} {
  const open = { type: 'object', properties: {}, additionalProperties: true }
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return { parameters: { type: 'object', properties: {} } }
  let size: number
  try {
    size = JSON.stringify(schema).length
  } catch {
    return { parameters: open, note: 'its input schema could not be read, so any arguments are accepted' }
  }
  if (size > MAX_SCHEMA_CHARS) {
    return {
      parameters: open,
      note: `its input schema was too large to send (${size} characters), so any arguments are accepted`
    }
  }
  const out: Record<string, unknown> = { ...schema }
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  const properties: Record<string, unknown> = isObj(out.properties) ? { ...out.properties } : {}
  const required = new Set(Array.isArray(out.required) ? out.required.filter((r) => typeof r === 'string') : [])
  for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
    const branches = out[key]
    if (!Array.isArray(branches)) continue
    for (const b of branches) {
      if (!isObj(b)) continue
      if (isObj(b.properties)) for (const [k, v] of Object.entries(b.properties)) if (!(k in properties)) properties[k] = v
      if (key === 'allOf' && Array.isArray(b.required)) for (const r of b.required) if (typeof r === 'string') required.add(r)
    }
    delete out[key]
  }
  delete out.enum
  delete out.not
  out.type = 'object'
  out.properties = properties
  if (required.size) out.required = [...required]
  else delete out.required
  return { parameters: out }
}
