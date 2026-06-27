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

/**
 * Split a shell command into whitespace-delimited tokens, honouring single- and
 * double-quoted spans (quotes stripped, contents kept). Good enough to scan
 * arguments for path-like tokens; not a full shell parser (no variable/command
 * substitution, no escape sequences).
 */
function tokenizeShellCommand(command: string): string[] {
  const tokens: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(command)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3] ?? '')
  }
  return tokens
}

/**
 * Whether a single path-like segment escapes the workspace: an absolute path
 * (`/etc/...`), a home-relative path (`~`, `~/...`), or a relative path that
 * climbs above the workspace root via `..` (`../x`, `a/../../b`). A relative path
 * that climbs then returns (`a/../b`) stays inside and does not escape.
 */
function segmentEscapesWorkspace(seg: string): boolean {
  if (!seg) return false
  if (seg.startsWith('/') || seg === '~' || seg.startsWith('~/')) return true
  // Only paths can climb out; a token with no "/" and no ".." can't.
  if (!seg.includes('/') && seg !== '..') return false
  let depth = 0
  for (const part of seg.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      depth -= 1
      if (depth < 0) return true
    } else {
      depth += 1
    }
  }
  return false
}

/**
 * Whether a `run_shell` command references a filesystem path outside the
 * workspace — an absolute path, a home (`~`) path, or a relative path that climbs
 * above the workspace root. Also inspects the value side of an `=` (so env
 * prefixes like `FOO=/etc/x` and flags like `--file=/etc/x` are caught).
 *
 * Best-effort and deliberately conservative: a command that escapes is escalated
 * for approval, never silently auto-run. It can't catch paths hidden behind
 * variable or command substitution — those defeat any static scan — so it's a
 * tripwire, not a sandbox. The sandbox remains the real confinement boundary.
 */
export function shellReferencesExternalPath(command: string): boolean {
  for (const token of tokenizeShellCommand(command)) {
    if (segmentEscapesWorkspace(token)) return true
    // `KEY=value` / `--flag=value`: the path may sit after the first `=`.
    const eq = token.indexOf('=')
    if (eq >= 0 && segmentEscapesWorkspace(token.slice(eq + 1))) return true
  }
  return false
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
