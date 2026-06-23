import { minimatch } from 'minimatch'
import type { PermissionRule } from '@shared/types'

/**
 * User-defined permission rules, consulted before the coarse approval policy.
 * Each rule matches a tool (by name, or `*` for any) and a glob over the call's
 * "subject" — the shell command, file path, URL, or query the call targets — and
 * resolves to allow (auto-approve), deny (refuse), or ask (always prompt). The
 * first matching rule wins; if none match, the approval policy decides.
 *
 * Examples: allow `run_shell` matching `git status*`; deny `run_shell` matching
 * `* rm -rf *`; ask `write_file` matching `**` (review every write).
 */

/** The string a permission rule's pattern is matched against, per tool. */
export function permissionSubject(toolName: string, args: Record<string, unknown>): string {
  const s = (k: string): string => (typeof args[k] === 'string' ? (args[k] as string) : '')
  switch (toolName) {
    case 'run_shell':
      return s('command')
    case 'web_fetch':
      return s('url')
    case 'web_search':
      return s('query')
    default:
      // Namespaced MCP tools (mcp__<id>__<tool>) take arbitrary args, so match on
      // the tool name itself — lets rules target a server/tool, e.g. `mcp__github__*`.
      if (toolName.startsWith('mcp__')) return toolName
      // File-ish tools target a path or pattern.
      return s('path') || s('pattern')
  }
}

function patternMatches(pattern: string, subject: string): boolean {
  const p = pattern.trim()
  if (!p || p === '*') return true
  // Glob match (commands have no "/" so minimatch's "*" spans the whole token);
  // dot:true so leading-dot paths still match.
  if (minimatch(subject, p, { dot: true })) return true
  // Fall back to a prefix match for convenience ("git status" matches "git").
  return subject === p || subject.startsWith(`${p} `)
}

/**
 * Resolve permission rules for a call. Returns the first matching rule's action,
 * or null when no rule matches (caller falls back to the approval policy).
 */
export function matchRule(
  rules: PermissionRule[] | undefined,
  toolName: string,
  subject: string
): PermissionRule['action'] | null {
  if (!rules?.length) return null
  for (const r of rules) {
    if (r.tool && r.tool !== '*' && r.tool !== toolName) continue
    if (patternMatches(r.match ?? '', subject)) return r.action
  }
  return null
}
