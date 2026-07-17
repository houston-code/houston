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
