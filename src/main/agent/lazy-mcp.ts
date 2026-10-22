import type { ChatMessage } from '@shared/agent'
import { DEFERRED_TOOL_CATALOG } from './deferred-tools'
import type { ToolDef } from './tools'

/**
 * Lazy tool loading.
 *
 * Every tool schema advertised to the model rides along on *every* request, and
 * their JSON parameter schemas are most of a request's fixed overhead: sending
 * them all on every turn bloats the context window (a 32k local model loses a
 * large share of it before the conversation starts) and bills uncached requests
 * for tools the model may never touch.
 *
 * Two kinds of tool are deferred. Built-ins listed in `DEFERRED_TOOL_CATALOG`
 * (deferred-tools.ts) always are. MCP tools are once more than
 * {@link MCP_LAZY_THRESHOLD} are connected; at or below it every MCP schema is
 * sent, so small setups pay no indirection. The model gets a compact catalog
 * (names + one-line summaries) inside the `find_tools` meta-tool, and loads only
 * the schemas it needs on demand.
 *
 * A loaded tool stays advertised for the rest of the conversation. Which tools are
 * loaded is derived from the conversation itself ({@link loadedDeferredTools}), not
 * kept as run state, so a later run of the same chat advertises the same tools in
 * the same order and the provider's prompt cache survives. Loaded schemas are
 * appended after everything else in the tool list, so the eager prefix never moves.
 *
 * Loading changes only what is advertised: a deferred tool goes through the same
 * lookup, plan-mode, permission, approval and hook gates as any other.
 */

/** Defer MCP tool schemas once more than this many are connected. */
export const MCP_LAZY_THRESHOLD = 15

/** Name of the meta-tool that reveals deferred tool schemas on demand. */
export const FIND_TOOLS_NAME = 'find_tools'

/** Cap on MCP catalog entries embedded in the find_tools description (keeps it bounded). */
const MAX_CATALOG = 200

/** How a successful find_tools result starts; the loop reads it to know the call loaded tools. */
const LOADED_PREFIX = 'Loaded '

/** One deferred tool as the catalog lists it. */
export interface CatalogEntry {
  def: ToolDef
  /** The one-line catalog summary the model sees until the tool is loaded. */
  summary: string
}

/** First sentence (or a clamped prefix) of a tool description, for the catalog. */
function shortDesc(desc: string): string {
  const oneLine = desc.replace(/\s+/g, ' ').trim()
  const stop = oneLine.indexOf('. ')
  const s = stop > 0 ? oneLine.slice(0, stop + 1) : oneLine
  return s.length > 140 ? `${s.slice(0, 139)}…` : s
}

/** Catalog entries for the deferred built-ins among a run's tools, in toolset order. */
export function builtinCatalogEntries(defs: ToolDef[]): CatalogEntry[] {
  return defs.flatMap((def) => {
    const summary = DEFERRED_TOOL_CATALOG[def.schema.name]
    return summary === undefined ? [] : [{ def, summary }]
  })
}

/** Catalog entries for MCP tools, summarized by the first sentence of their description. */
export function mcpCatalogEntries(defs: ToolDef[]): CatalogEntry[] {
  return defs.map((def) => ({ def, summary: shortDesc(def.schema.description) }))
}

/** A compact "name: summary" list of catalog entries, capped at {@link MAX_CATALOG}. */
export function catalogLines(entries: CatalogEntry[]): string {
  const lines = entries.slice(0, MAX_CATALOG).map((e) => `- ${e.def.schema.name}: ${e.summary}`)
  if (entries.length > MAX_CATALOG) lines.push(`- …and ${entries.length - MAX_CATALOG} more`)
  return lines.join('\n')
}

/**
 * Catalog entries matching a search query. An empty query, `*`, or `all` matches
 * everything; otherwise terms separated by whitespace or commas are matched
 * case-insensitively against each tool's name, then its summary and description
 * (name matches rank above the rest), and only tools matching at least one term are
 * returned. Exact tool names work as terms, so `gh_pr_view, gh_pr_checks` loads both.
 */
export function searchCatalog(entries: CatalogEntry[], query: string): CatalogEntry[] {
  const q = query.trim().toLowerCase()
  if (q === '' || q === '*' || q === 'all') return entries
  const terms = q.split(/[\s,]+/).filter(Boolean)
  const scored: { entry: CatalogEntry; score: number }[] = []
  for (const entry of entries) {
    const name = entry.def.schema.name.toLowerCase()
    const text = `${entry.summary}\n${entry.def.schema.description}`.toLowerCase()
    let score = 0
    for (const t of terms) {
      if (name.includes(t)) score += 2
      else if (text.includes(t)) score += 1
    }
    if (score > 0) scored.push({ entry, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.map((s) => s.entry)
}

function queryOf(args: Record<string, unknown>): string {
  return typeof args.query === 'string' ? args.query : ''
}

/**
 * Build the per-run `find_tools` meta-tool over the run's deferred built-ins and
 * (when lazy) MCP tools. Calling it reports which tools matched; the loop then
 * advertises them from the next step on (see {@link loadedDeferredTools}), so the
 * result names them rather than repeating schemas the next request carries anyway.
 */
export function makeFindToolsDef(builtins: CatalogEntry[], mcp: CatalogEntry[]): ToolDef {
  const entries = [...builtins, ...mcp]
  const sections = [
    builtins.length ? `Houston tools:\n${catalogLines(builtins)}` : '',
    mcp.length ? `MCP tools (${mcp.length} from connected servers):\n${catalogLines(mcp)}` : ''
  ].filter(Boolean)
  const catalog = sections.join('\n\n')
  return {
    kind: 'read',
    summarize: (a) => `Find tools: ${queryOf(a) || '*'}`,
    schema: {
      name: FIND_TOOLS_NAME,
      description:
        `Load tools that are available but not preloaded, to save context. Each is listed below with when to use it. ` +
        `Before calling one, load it here by name or keyword (matched against tool names and descriptions; "*" loads ` +
        `all). A loaded tool is callable from your next step and stays loaded for the rest of the conversation.\n\n${catalog}`,
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Tool names or keywords to match (e.g. "gh_pr_create, gh_pr_view" or "schedule"), or "*" for all.'
          }
        },
        required: ['query'],
        additionalProperties: false
      }
    },
    execute: (args) => {
      const query = queryOf(args)
      const matches = searchCatalog(entries, query)
      if (matches.length === 0) {
        return Promise.resolve(
          `No tools matched "${query}". Use a name or keyword from the list in this tool's description, or "*".`
        )
      }
      return Promise.resolve(
        `${LOADED_PREFIX}${matches.length} tool(s), callable from your next step: ${matches
          .map((m) => m.def.schema.name)
          .join(', ')}`
      )
    }
  }
}

/**
 * The deferred tools a conversation has loaded, in the order it loaded them: every
 * tool a successful find_tools call matched (re-running its query against the
 * current catalog), and every deferred tool the model called directly. Derived from
 * the full persisted log on each step, so the set survives across runs of a chat,
 * and a history that holds a call to a tool always declares that tool.
 */
export function loadedDeferredTools(messages: ChatMessage[], entries: CatalogEntry[]): ToolDef[] {
  const byName = new Map(entries.map((e) => [e.def.schema.name, e.def]))
  const results = new Map<string, string>()
  for (const m of messages) {
    if (m.role === 'tool' && m.toolCallId) results.set(m.toolCallId, m.content)
  }
  const loaded = new Map<string, ToolDef>()
  for (const m of messages) {
    if (m.role !== 'assistant') continue
    for (const call of m.toolCalls ?? []) {
      if (call.name === FIND_TOOLS_NAME) {
        if (!(results.get(call.id) ?? '').startsWith(LOADED_PREFIX)) continue
        for (const e of searchCatalog(entries, queryOf(call.arguments))) {
          if (!loaded.has(e.def.schema.name)) loaded.set(e.def.schema.name, e.def)
        }
      } else {
        const def = byName.get(call.name)
        if (def && !loaded.has(call.name)) loaded.set(call.name, def)
      }
    }
  }
  return [...loaded.values()]
}
