import { realpathSync } from 'node:fs'
import { basename as pathBasename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parsePatch } from './apply-patch'
import type { ToolKind } from './tools'

/**
 * Whether a file path names a credential / secret store whose contents an agent
 * should not read without the user's say-so.
 *
 * The structured read tools are already confined to the workspace, so this only
 * ever fires on a secret file that lives INSIDE the workspace (or an added root) —
 * a committed `.env`, a private key checked in as a fixture, a stray
 * `.git-credentials`. That's the real exposure: the file is reachable, `read_file`
 * never prompts, and output redaction only scrubs *recognized* token formats, so an
 * arbitrary secret (a DB password, a private-key body) would otherwise flow straight
 * into the transcript. Reading one is treated like the other exfiltration-adjacent
 * actions (network egress, unconfined shell): it prompts even in full-auto, and an
 * explicit `allow` permission rule or an "allow for run" is how the user opts in.
 *
 * The match is by basename and path segment, so it works on a raw relative or
 * absolute argument without touching the filesystem. It errs toward prompting
 * (the prompt is escapable) but stays tight enough to avoid firing on ordinary
 * source: public keys, `.env.example`, and `known_hosts` are deliberately excluded.
 * Pure and deterministic — unit-tested without a filesystem.
 */

/** Private-key / certificate material by extension. */
const SECRET_EXTENSIONS = new Set([
  'pem',
  'key',
  'pfx',
  'p12',
  'pkcs12',
  'ppk',
  'keystore',
  'jks'
])

/** SSH private-key filenames (the matching `.pub` is public and excluded). */
const SSH_PRIVATE_KEYS = new Set(['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'])

/** Credential/token stores identified by their exact (lowercased) basename. */
const SECRET_BASENAMES = new Set([
  '.netrc',
  '_netrc',
  '.git-credentials',
  '.pgpass',
  '.npmrc',
  '.pypirc',
  '.dockercfg',
  'credentials.json',
  'service-account.json',
  'serviceaccount.json'
])

/** dotenv variants that hold no secrets and shouldn't prompt. */
const ENV_TEMPLATE_SUFFIX = /\.(example|sample|template|dist|defaults?)$/

function basename(p: string): string {
  const norm = p.replace(/\\/g, '/')
  const cut = norm.slice(norm.lastIndexOf('/') + 1)
  return cut
}

/** Whether `path` names a credential / secret file that a read should gate on. */
export function isSensitivePath(path: string): boolean {
  if (!path) return false
  const norm = path.replace(/\\/g, '/')
  const segments = norm.toLowerCase().split('/')
  const base = basename(norm)
  const lower = base.toLowerCase()

  // dotenv: .env and .env.<env>, but not the committed templates.
  if (lower === '.env') return true
  if (lower.startsWith('.env.') && !ENV_TEMPLATE_SUFFIX.test(lower)) return true

  if (SSH_PRIVATE_KEYS.has(lower)) return true
  // Anything directly under an `.ssh/` directory that isn't a public artifact is a
  // key (custom-named private keys live here too).
  if (
    segments.includes('.ssh') &&
    !lower.endsWith('.pub') &&
    lower !== 'known_hosts' &&
    lower !== 'config' &&
    lower !== 'authorized_keys'
  ) {
    return true
  }

  const dot = lower.lastIndexOf('.')
  const ext = dot > 0 ? lower.slice(dot + 1) : ''
  if (SECRET_EXTENSIONS.has(ext)) return true

  if (SECRET_BASENAMES.has(lower)) return true

  // Cloud-provider credential stores, keyed on their directory + filename so a
  // generic name like `credentials` only matches in the right place.
  if (segments.includes('.aws') && lower === 'credentials') return true
  if (segments.includes('.kube') && lower === 'config') return true
  if (segments.includes('.docker') && lower === 'config.json') return true
  if (segments.includes('gcloud') && lower.endsWith('.json') && lower.includes('credential')) {
    return true
  }
  if (lower.endsWith('service-account.json') || lower.endsWith('serviceaccount.json')) return true

  return false
}

/** Files directly in a git dir that make git run, or find, commands (see gitGuard.ts). */
const GIT_EXEC_FILES = new Set(['config', 'config.worktree', 'commondir'])

/**
 * Whether `path` names a part of a repository's git data that makes git run a command
 * on its own: a hook, the repo's config (core.fsmonitor, filter drivers, …), a
 * `commondir` redirect, or the `.git` pointer file itself. A write there lands outside
 * anything `git status` or a diff shows, and runs the next time the user's own git
 * touches the repo, outside the sandbox. Covers submodule and linked-worktree git dirs
 * (`.git/modules/…`, `.git/worktrees/…`). Matched by path segment; pure.
 */
export function isGitExecPath(path: string): boolean {
  if (!path) return false
  const segments = path.replace(/\\/g, '/').toLowerCase().split('/').filter((s) => s && s !== '.')
  const last = segments.length - 1
  if (segments[last] === '.git') return true
  const at = segments.indexOf('.git')
  if (at < 0) return false
  const tail = segments.slice(at + 1)
  return tail.includes('hooks') || GIT_EXEC_FILES.has(segments[last]!)
}

/**
 * Whether a tool call is a read of a credential / secret file: a read-kind call
 * whose `path` argument {@link isSensitivePath}. The one definition shared by the
 * loop's approval gate, its parallel-read scheduler, and the subagent gate, so no
 * path can judge the same call benign that another would have prompted for.
 */
export function isSensitiveRead(kind: ToolKind, args: Record<string, unknown>): boolean {
  if (kind !== 'read') return false
  if (typeof args.path === 'string' && isSensitivePath(args.path)) return true
  // show_images reads one path per entry. It only attaches files that sniff as
  // images, but a path naming a credential store still prompts, as read_file does.
  return (
    Array.isArray(args.images) &&
    args.images.some((img) => {
      if (typeof img !== 'object' || img === null) return false
      const o = img as Record<string, unknown>
      return [o.path, o.compareWith].some((p) => typeof p === 'string' && isSensitivePath(p))
    })
  )
}

/**
 * Whether a file-writing tool call targets a credential / secret file (see
 * {@link isSensitivePath}) or git's exec-capable data (see {@link isGitExecPath}):
 * `path` for the single-file tools, every added, updated, deleted, or moved-to path
 * for `apply_patch`. Writes to these files prompt even in full-auto: they are rarely
 * edited, overwriting a secret (a build check that resets `.env`, a write-back of a
 * masked value) silently destroys something only the user can restore, and a hook or
 * git setting runs code outside the sandbox later. A patch that doesn't parse names
 * no targets; the tool itself rejects it.
 */
export function writesSensitivePath(toolName: string, args: Record<string, unknown>): boolean {
  const sensitive = (p: string): boolean => isSensitivePath(p) || isGitExecPath(p)
  if (toolName === 'apply_patch') {
    if (typeof args.patch !== 'string') return false
    try {
      return parsePatch(args.patch).some(
        (op) => sensitive(op.path) || (op.type === 'update' && !!op.moveTo && sensitive(op.moveTo))
      )
    } catch {
      return false
    }
  }
  return typeof args.path === 'string' && sensitive(args.path)
}

/**
 * In-project control files: files inside the workspace that make a program run code
 * outside the sandbox later, or that steer the agent's own guardrails.
 *
 * The sandbox keeps the agent's commands inside the project, but these files are
 * read and acted on by something else after the call, unconfined:
 *
 *  - `.houston/`: Houston's own project config (hooks, MCP servers, allow rules),
 *    plugins (JavaScript the main process evaluates), agents, skills, and commands.
 *    An agent that could edit these could widen its own permissions for the next run.
 *  - `.vscode/`, `.idea/`: editor tasks, launch configs, and settings that run
 *    commands when the user opens the folder or builds.
 *  - `.envrc`: direnv runs it as a shell script on `cd`, in any directory.
 *  - `.husky/`: git hook scripts, installed through `core.hooksPath`.
 *  - `.mcp.json`: MCP servers an editor or agent tool launches for the folder.
 *  - `.devcontainer/`: container build and lifecycle commands an editor runs.
 *  - `.github/workflows/`, `.github/actions/`: CI code that runs with the
 *    repository's secrets once pushed.
 *
 * A write to one asks in every approval mode, full auto included; only an explicit
 * `allow` permission rule for that path skips it (see decideApproval's
 * `protectedWrite`). Unlike a credential file, "Allow for run" does not cover it: a
 * run-wide write grant was consent to edit the project, not to plant code that runs
 * outside it.
 */
const PROTECTED_DIRS: readonly (readonly string[])[] = [
  ['.houston'],
  ['.vscode'],
  ['.idea'],
  ['.husky'],
  ['.devcontainer'],
  ['.github', 'workflows'],
  ['.github', 'actions']
]
const PROTECTED_FILES = new Set(['.envrc', '.mcp.json'])

/**
 * Whether a path RELATIVE to a workspace root names (or lies inside) an in-project
 * control file (see {@link PROTECTED_DIRS}). Matched per path segment at any depth,
 * case-insensitively (the default macOS and Windows file systems are), so a nested
 * package's `.vscode/tasks.json` counts too, and so does the directory itself
 * (`cp -r x .husky`). Pure.
 */
export function isProtectedControlRelPath(rel: string): boolean {
  if (!rel) return false
  const segments = rel
    .replace(/\\/g, '/')
    .toLowerCase()
    .split('/')
    .filter((s) => s && s !== '.')
  for (let i = 0; i < segments.length; i++) {
    if (PROTECTED_FILES.has(segments[i]!)) return true
    for (const dir of PROTECTED_DIRS) {
      if (dir.every((part, k) => segments[i + k] === part)) return true
    }
  }
  return false
}

/** `abs` relative to the innermost root that contains it, or null when none does. */
function relativeToInnermostRoot(abs: string, roots: string[]): string | null {
  let best: string | null = null
  for (const root of roots) {
    const rel = relative(root, abs)
    const inside = rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
    if (inside && (best === null || rel.length < best.length)) best = rel
  }
  return best
}

/**
 * realpath, with Windows 8.3 short names expanded. The JS realpath only resolves
 * links, so `HOUSTO~1` (a second name for `.houston`) would come back as written and
 * slip past the segment match; the native one returns the long name. A native failure
 * other than a missing path falls back to the JS walk.
 */
function realpathLong(p: string): string {
  if (process.platform !== 'win32') return realpathSync(p)
  try {
    return realpathSync.native(p)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') throw e
    return realpathSync(p)
  }
}

/**
 * The real location of `abs`: its deepest existing ancestor realpath'd with the
 * not-yet-existing rest re-attached (a write may create the file). Null when it
 * can't be resolved for another reason (a symlink loop).
 */
function realLocation(abs: string): string | null {
  let dir = abs
  const tail: string[] = []
  for (;;) {
    try {
      return join(realpathLong(dir), ...tail.reverse())
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null
      const parent = dirname(dir)
      if (parent === dir) return null
      tail.push(pathBasename(dir))
      dir = parent
    }
  }
}

/**
 * Whether `path` (as a tool or shell command names it: relative to the first root,
 * or absolute) is an in-project control file. Read against the INNERMOST root that
 * holds it, so a chat whose workspace is a worktree under `<repo>/.houston/worktrees/`
 * isn't flagged for every file just because an ancestor is named `.houston`, while
 * the worktree's own `.houston/settings.json` still is. Also judged at the path's
 * real location (symlinks resolved), so a link named `editor` pointing at `.vscode`
 * doesn't hide `editor/tasks.json`. A path outside every root is judged as written:
 * the file tools refuse it, and a shell command naming it already asks.
 */
export function isProtectedControlPath(path: string, roots: string[]): boolean {
  if (!path) return false
  if (roots.length === 0) return isProtectedControlRelPath(path)
  const lexicalRoots = roots.map((r) => resolve(r))
  const abs = isAbsolute(path) ? resolve(path) : resolve(lexicalRoots[0]!, path)
  const lexical = relativeToInnermostRoot(abs, lexicalRoots)
  if (lexical === null) return isProtectedControlRelPath(path)
  if (isProtectedControlRelPath(lexical)) return true
  const real = realLocation(abs)
  if (real === null) return false
  const realRoots = lexicalRoots.map((r) => realLocation(r) ?? r)
  const realRel = relativeToInnermostRoot(real, realRoots)
  return realRel !== null && isProtectedControlRelPath(realRel)
}

/**
 * Whether a file-writing tool call targets an in-project control file (see
 * {@link isProtectedControlPath}): `path` for the single-file tools, every added,
 * updated, deleted, or moved-to path for `apply_patch`. A patch that doesn't parse
 * names no targets; the tool itself rejects it.
 */
export function writesProtectedPath(
  toolName: string,
  args: Record<string, unknown>,
  roots: string[]
): boolean {
  const hit = (p: string): boolean => isProtectedControlPath(p, roots)
  if (toolName === 'apply_patch') {
    if (typeof args.patch !== 'string') return false
    try {
      return parsePatch(args.patch).some(
        (op) => hit(op.path) || (op.type === 'update' && !!op.moveTo && hit(op.moveTo))
      )
    } catch {
      return false
    }
  }
  return typeof args.path === 'string' && hit(args.path)
}
