import type { ToolDef } from './tools'

/**
 * Lazy MCP tool loading.
 *
 * Every tool schema advertised to the model rides along on *every* request. A
 * handful of MCP servers can contribute dozens of tools, and their JSON parameter
 * schemas are the bulk of the weight — sending them all on every turn bloats the
 * context window and bills BYO-model users for tools the model may never touch.
 *
 * Above {@link MCP_LAZY_THRESHOLD} connected MCP tools we defer them: the model
 * gets a compact catalog (names + one-line summaries) plus a `find_tools`
 * meta-tool, and loads only the schemas it needs on demand. Loaded tools then
 * ride along on subsequent turns. At or below the threshold nothing changes —
 * every MCP schema is sent — so small setups pay no indirection.
 */

/** Defer MCP tool schemas once more than this many are connected. */
export const MCP_LAZY_THRESHOLD = 15

/** Name of the meta-tool that reveals deferred MCP tool schemas on demand. */
export const FIND_TOOLS_NAME = 'find_tools'

/** Cap on catalog entries embedded in the find_tools description (keeps it bounded). */
const MAX_CATALOG = 200

/** First sentence (or a clamped prefix) of a tool description, for the catalog. */
function shortDesc(desc: string): string {
  const oneLine = desc.replace(/\s+/g, ' ').trim()
  const stop = oneLine.indexOf('. ')
  const s = stop > 0 ? oneLine.slice(0, stop + 1) : oneLine
  return s.length > 140 ? `${s.slice(0, 139)}…` : s
}

/** A compact "name — summary" list of MCP tools for the find_tools description. */
export function mcpCatalog(defs: ToolDef[]): string {
  const lines = defs
    .slice(0, MAX_CATALOG)
    .map((d) => `- ${d.schema.name} — ${shortDesc(d.schema.description)}`)
  if (defs.length > MAX_CATALOG) lines.push(`- …and ${defs.length - MAX_CATALOG} more`)
  return lines.join('\n')
}

/**
 * MCP tools matching a search query. An empty query, `*`, or `all` matches
 * everything; otherwise whitespace-separated terms are matched case-insensitively
 * against each tool's name and description (name matches rank above description
 * matches), and only tools matching at least one term are returned.
 */
export function searchMcpDefs(defs: ToolDef[], query: string): ToolDef[] {
  const q = query.trim().toLowerCase()
  if (q === '' || q === '*' || q === 'all') return defs
  const terms = q.split(/\s+/).filter(Boolean)
  const scored: { def: ToolDef; score: number }[] = []
  for (const def of defs) {
    const name = def.schema.name.toLowerCase()
    const desc = def.schema.description.toLowerCase()
    let score = 0
    for (const t of terms) {
      if (name.includes(t)) score += 2
      else if (desc.includes(t)) score += 1
    }
    if (score > 0) scored.push({ def, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.map((s) => s.def)
}

/** Render loaded schemas as text the model can act on (name, description, params). */
function describeLoaded(defs: ToolDef[]): string {
  return defs
    .map(
      (d) =>
        `${d.schema.name}: ${d.schema.description}\nparameters: ${JSON.stringify(d.schema.parameters)}`
    )
    .join('\n\n')
}

/**
 * Build the per-run `find_tools` meta-tool. Calling it reveals the MCP tools that
 * match the query — adding their names to `revealed` (a set the loop reads when
 * deciding which schemas to advertise next turn) — and returns their full schemas
 * so the model can call them immediately on the following step.
 */
export function makeFindToolsDef(defs: ToolDef[], revealed: Set<string>): ToolDef {
  return {
    kind: 'read',
    summarize: (a) => `Find tools: ${typeof a.query === 'string' && a.query ? a.query : '*'}`,
    schema: {
      name: FIND_TOOLS_NAME,
      description:
        `${defs.length} MCP tools are connected, but their full schemas aren't preloaded (to save context). ` +
        `Call this with a keyword query — matched against tool names and descriptions, or "*" for all — to load ` +
        `the ones you need; loaded tools become callable on the next step. Search here before calling any tool ` +
        `listed below.\n\nAvailable MCP tools:\n${mcpCatalog(defs)}`,
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Keyword(s) to match against MCP tool names/descriptions, or "*" to load all of them.'
          }
        },
        required: ['query'],
        additionalProperties: false
      }
    },
    execute: (args) => {
      const query = typeof args.query === 'string' ? args.query : ''
      const matches = searchMcpDefs(defs, query)
      if (matches.length === 0) {
        return Promise.resolve(
          `No MCP tools matched "${query}". Available MCP tools:\n${mcpCatalog(defs)}`
        )
      }
      for (const m of matches) revealed.add(m.schema.name)
      return Promise.resolve(
        `Loaded ${matches.length} tool(s) — now callable on your next step:\n\n${describeLoaded(matches)}`
      )
    }
  }
}
