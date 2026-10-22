import type { ToolScope, ToolScopeEntry } from '@shared/agent'
import type { PermissionRule } from '@shared/types'
import { matchRule } from './permissions'

/**
 * A run's tool scope: the headless `--allowed-tools` / `--disallowed-tools` lists.
 *
 * Each entry is a tool name (`read_file`, `mcp__github__*`) or a tool name with a
 * permission-rule pattern (`run_shell(git *)`, `write_file(src/**)`), matched by the
 * same canonicalizing matcher as permission rules (see permissions.ts), so a
 * re-spelled command or path can't slip past it.
 *
 * The scope only ever narrows. A disallowed match refuses the call, an allowed list
 * refuses every call it doesn't cover, and a call inside the scope still goes
 * through the run's rules and approval policy exactly as it would without one: an
 * allowed entry is never an approval. Disallowed wins over allowed.
 */

/** Longest tool list one flag may carry, so a runaway script can't hand the matcher megabytes. */
const MAX_ENTRIES = 200

/** A tool name, or a tool-name glob with `*` (`mcp__github__*`). */
const TOOL_NAME = /^[A-Za-z0-9_.*-]+$/

/**
 * Parse one `--allowed-tools` / `--disallowed-tools` value: entries separated by
 * commas (a comma inside a pattern's parentheses belongs to the pattern). Returns
 * the entries, or an error message naming the first bad one.
 */
export function parseToolList(raw: string, flag: string): { entries: ToolScopeEntry[] } | { error: string } {
  const items: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (c === '(') depth++
    else if (c === ')') depth = Math.max(0, depth - 1)
    else if (c === ',' && depth === 0) {
      items.push(raw.slice(start, i))
      start = i + 1
    }
  }
  items.push(raw.slice(start))
  const entries: ToolScopeEntry[] = []
  for (const rawItem of items) {
    const item = rawItem.trim()
    if (!item) {
      if (items.length === 1) return { error: `${flag} needs at least one tool name, like ${flag} read_file,glob` }
      return { error: `${flag} has an empty entry; separate tool names with single commas` }
    }
    const open = item.indexOf('(')
    const name = (open >= 0 ? item.slice(0, open) : item).trim()
    if (!TOOL_NAME.test(name)) {
      return {
        error: `${flag}: ${JSON.stringify(item)} is not a tool name or name(pattern); separate entries with commas`
      }
    }
    if (open < 0) {
      entries.push({ tool: name, match: '*' })
      continue
    }
    if (!item.endsWith(')')) return { error: `${flag}: ${JSON.stringify(item)} is missing its closing parenthesis` }
    const match = item.slice(open + 1, -1).trim()
    if (!match) return { error: `${flag}: ${JSON.stringify(item)} has an empty pattern; drop the parentheses to name the whole tool` }
    entries.push({ tool: name, match })
  }
  if (entries.length > MAX_ENTRIES) return { error: `${flag} lists more than ${MAX_ENTRIES} entries` }
  return { entries }
}

/** Whether a tool-name entry (`*` the only wildcard) names `tool`. */
export function toolNameMatches(pattern: string, tool: string): boolean {
  if (pattern === '*' || pattern === tool) return true
  if (!pattern.includes('*')) return false
  const re = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${re}$`).test(tool)
}

const coversWholeTool = (e: ToolScopeEntry): boolean => e.match === '*'

/**
 * Whether the run offers `tool` to the model at all. A tool disallowed outright, or
 * one no allowed entry names, is left out of the toolset (and so out of the system
 * prompt). A tool named only with a pattern stays offered: some of its calls are in
 * scope, and {@link scopeVerdict} refuses the rest.
 */
export function toolOffered(scope: ToolScope | undefined, tool: string): boolean {
  if (!scope) return true
  if (scope.disallowed?.some((e) => coversWholeTool(e) && toolNameMatches(e.tool, tool))) return false
  if (scope.allowed && !scope.allowed.some((e) => toolNameMatches(e.tool, tool))) return false
  return true
}

/** Why the scope refuses a call, or null when the call is inside it. */
export type ScopeRefusal = 'disallowed' | 'not-allowed'

/**
 * Check one call against the scope. `subject` is the call's permission subject
 * (`permissionSubject` in permissions.ts) and `roots` the workspace roots, so path
 * and command patterns read exactly as permission rules do.
 */
export function scopeVerdict(
  scope: ToolScope | undefined,
  tool: string,
  subject: string,
  roots: string[]
): ScopeRefusal | null {
  if (!scope) return null
  const named = (list: ToolScopeEntry[] | undefined): ToolScopeEntry[] =>
    (list ?? []).filter((e) => toolNameMatches(e.tool, tool))
  const rulesFor = (entries: ToolScopeEntry[], action: PermissionRule['action']): PermissionRule[] =>
    entries.map((e) => ({ action, tool, match: e.match }))

  const denied = named(scope.disallowed)
  if (denied.some(coversWholeTool)) return 'disallowed'
  if (denied.length && matchRule(rulesFor(denied, 'deny'), tool, subject, roots) === 'deny') return 'disallowed'

  if (!scope.allowed) return null
  const allowed = named(scope.allowed)
  if (allowed.some(coversWholeTool)) return null
  // An allow reads a shell command strictly (every chained sub-command must be
  // covered, quoting kept), so a pattern can't be stretched over a longer command.
  if (allowed.length && matchRule(rulesFor(allowed, 'allow'), tool, subject, roots) === 'allow') return null
  return 'not-allowed'
}

/** The tool result a refused call gets, so the model knows not to retry it. */
export function scopeRefusalText(refusal: ScopeRefusal): string {
  return refusal === 'disallowed'
    ? 'Denied: this tool call is disallowed for this run. Do not retry it; continue without it.'
    : 'Denied: this tool call is outside the tools allowed for this run. Do not retry it; continue with the tools you have.'
}
