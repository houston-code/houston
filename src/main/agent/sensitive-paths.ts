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
