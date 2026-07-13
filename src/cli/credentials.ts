import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getUserDataDir } from '../main/userData'
import {
  allProviderKeyEnvVars,
  genericKeyEnvVar,
  providerKeyEnvVars
} from '@shared/provider-keys'

/**
 * Credential source for the standalone CLI. Electron's `safeStorage` (the desktop
 * app's secret store) needs a running Electron app AND an OS keyring, so the CLI —
 * often on a headless server with neither — resolves keys from, in order:
 *
 *   1. Environment variables — the native pattern for servers and CI. Well-known
 *      names (ANTHROPIC_API_KEY, OPENAI_API_KEY, …) plus a generic
 *      `HOUSTON_API_KEY_<ID>` form that covers custom providers.
 *   2. `cli-credentials.json` in the profile dir — a flat `{ "<id>": "<key>" }`
 *      map the user creates by hand for keys that should persist across shells.
 *      Plaintext by design (documented in the README): a headless box has no OS
 *      keyring to encrypt against, so we follow the same model as other developer
 *      CLIs' credential files and warn when the file is group/world-readable.
 *
 * Keys stored by the desktop app are NOT readable here: their ciphertext is bound
 * to safeStorage's OS-keyring key, which only the Electron app can unlock — and a
 * plaintext fallback that silently decrypted the GUI's secrets would be worse than
 * the gap. The ids are shared with the desktop app's secrets store (provider ids
 * like `anthropic`, plus web-search key ids like `web-search:brave`).
 */

/**
 * Well-known env vars for non-provider credential ids (web-search keys). Provider
 * key env vars live in @shared/provider-keys — the single source of truth shared
 * with the missing-key preflight — so a new catalog host only needs adding there.
 * Tavily reuses the legacy bare id (see @shared/search).
 */
const WEB_SEARCH_ENV_ALIASES: Record<string, string[]> = {
  'web-search': ['TAVILY_API_KEY'],
  'web-search:brave': ['BRAVE_API_KEY'],
  'web-search:exa': ['EXA_API_KEY']
}

/** `HOUSTON_API_KEY_<ID>` with the id uppercased and non-alphanumerics collapsed to `_`. */
export function genericEnvVar(id: string): string {
  return genericKeyEnvVar(id)
}

/**
 * The env var names checked for a credential id, in precedence order: any
 * web-search alias, then the provider's documented name(s) + generic fallback.
 * (For a provider id there's no web-search alias, so this is exactly the provider
 * key env vars; for a web-search id the provider map has no entry, so it's the
 * alias + generic form.)
 */
export function envVarCandidates(id: string): string[] {
  return [...(WEB_SEARCH_ENV_ALIASES[id] ?? []), ...providerKeyEnvVars(id)]
}

export interface CredentialDeps {
  env?: NodeJS.ProcessEnv
  /** Profile dir holding cli-credentials.json (default: the wired userData dir). */
  dataDir?: string
  /** Sink for the loose-permissions warning (default: stderr). */
  warn?: (message: string) => void
}

function keyFromEnv(id: string, env: NodeJS.ProcessEnv): string | null {
  for (const name of envVarCandidates(id)) {
    const value = env[name]
    if (value) return value
  }
  return null
}

/** Warn once per process about a group/world-readable credentials file. */
let warnedLoosePerms = false
/** Warn once per process about an unparseable credentials file. */
let warnedMalformedCreds = false

function keyFromFile(id: string, dataDir: string, warn: (m: string) => void): string | null {
  const path = join(dataDir, 'cli-credentials.json')
  let raw: string
  try {
    // POSIX only: on Windows mode bits don't carry ACLs, so skip the check there.
    if (process.platform !== 'win32' && !warnedLoosePerms) {
      const mode = statSync(path).mode
      if ((mode & 0o077) !== 0) {
        warnedLoosePerms = true
        warn(
          `Warning: ${path} is readable by other users — run: chmod 600 "${path}"\n`
        )
      }
    }
    raw = readFileSync(path, 'utf8')
  } catch {
    return null // no credentials file — the common case
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const value = parsed?.[id]
    return typeof value === 'string' && value.length > 0 ? value : null
  } catch {
    // Malformed JSON: don't crash the run, but the file exists and was meant to
    // hold keys, so a silent "no key set" later would be baffling — say why.
    if (!warnedMalformedCreds) {
      warnedMalformedCreds = true
      warn(`Warning: ${path} is not valid JSON — ignoring it. Expected {"<provider-id>": "<key>"}.\n`)
    }
    return null
  }
}

/** Warn once per process about a group/world-readable headers file. */
let warnedLooseHeaderPerms = false
/** Warn once per process about an unparseable headers file. */
let warnedMalformedHeaders = false

/** Test-only: reset the once-per-process warnings. */
export function resetCredentialWarnings(): void {
  warnedLoosePerms = false
  warnedLooseHeaderPerms = false
  warnedMalformedCreds = false
  warnedMalformedHeaders = false
}

/**
 * Custom auth/attribution headers for a provider or MCP-server scope, for the CLI.
 * Header values can be bearer tokens, so — like keys — the desktop app keeps them in
 * safeStorage, which is unreadable here; the CLI resolves them from `cli-headers.json`
 * in the profile dir: a `{ "<scope>": { "<Header>": "<value>" } }` map, where a scope
 * is `provider:<id>` or `mcp:<id>` (see the header-scope helpers in @shared/types).
 * Plaintext by design and warned-on when group/world-readable, matching the keys file.
 * Returns `{}` when absent or malformed — a run just sends no custom headers.
 */
export function cliGetHeaders(scope: string, deps: CredentialDeps = {}): Record<string, string> {
  const dataDir = deps.dataDir ?? getUserDataDir()
  const warn = deps.warn ?? ((m: string) => process.stderr.write(m))
  const path = join(dataDir, 'cli-headers.json')
  let raw: string
  try {
    if (process.platform !== 'win32' && !warnedLooseHeaderPerms) {
      const mode = statSync(path).mode
      if ((mode & 0o077) !== 0) {
        warnedLooseHeaderPerms = true
        warn(`Warning: ${path} is readable by other users — run: chmod 600 "${path}"\n`)
      }
    }
    raw = readFileSync(path, 'utf8')
  } catch {
    return {} // no headers file — the common case
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const entry = parsed?.[scope]
    if (!entry || typeof entry !== 'object') return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(entry as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v
    }
    return out
  } catch {
    // Malformed JSON: don't crash the run, but say why the headers were ignored.
    if (!warnedMalformedHeaders) {
      warnedMalformedHeaders = true
      warn(`Warning: ${path} is not valid JSON — ignoring it.\n`)
    }
    return {}
  }
}

/** Read a JSON object from `path`, or `{}` if absent/malformed. No perms warning — the
 *  normal key/header resolution path already surfaces that. */
function readJsonObject(path: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Secret-shaped opaque tokens inside a header value (see the desktop store's
 *  equivalent): a header is often `Scheme token`, so take each whitespace-delimited run
 *  long enough to be a credential rather than a scheme word or a common value. */
function secretTokensFromHeader(value: string): string[] {
  return value.split(/\s+/).filter((t) => t.length >= 20)
}

/**
 * Every plaintext secret the CLI can resolve, for the tool-result/log redactor (see
 * main/agent/redact.ts). Pulls from the same three sources as key/header resolution:
 * credential env vars, cli-credentials.json, and cli-headers.json. Best-effort —
 * unreadable or malformed sources contribute nothing.
 */
export function cliCollectSecrets(deps: CredentialDeps = {}): string[] {
  const env = deps.env ?? process.env
  const dataDir = deps.dataDir ?? getUserDataDir()
  const out = new Set<string>()

  // Env: the well-known per-provider + web-search vars plus any generic
  // HOUSTON_API_KEY_* override.
  const knownEnvNames = new Set<string>([
    ...allProviderKeyEnvVars(),
    ...Object.values(WEB_SEARCH_ENV_ALIASES).flat()
  ])
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < 8) continue
    if (knownEnvNames.has(name) || name.startsWith('HOUSTON_API_KEY_')) out.add(value)
  }

  // cli-credentials.json: a flat { "<id>": "<key>" } map.
  for (const v of Object.values(readJsonObject(join(dataDir, 'cli-credentials.json')))) {
    if (typeof v === 'string' && v.length >= 8) out.add(v)
  }

  // cli-headers.json: { "<scope>": { "<Header>": "<value>" } } — only secret-shaped tokens.
  for (const entry of Object.values(readJsonObject(join(dataDir, 'cli-headers.json')))) {
    if (!entry || typeof entry !== 'object') continue
    for (const v of Object.values(entry as Record<string, unknown>)) {
      if (typeof v === 'string') for (const tok of secretTokensFromHeader(v)) out.add(tok)
    }
  }
  return [...out]
}

/** Resolve a credential: environment first, then cli-credentials.json. */
export function cliGetKey(id: string, deps: CredentialDeps = {}): string | null {
  const env = deps.env ?? process.env
  const warn = deps.warn ?? ((m: string) => process.stderr.write(m))
  const fromEnv = keyFromEnv(id, env)
  if (fromEnv) return fromEnv
  return keyFromFile(id, deps.dataDir ?? getUserDataDir(), warn)
}

/** True when `cliGetKey` would resolve a credential for this id. */
export function cliHasKey(id: string, deps: CredentialDeps = {}): boolean {
  return cliGetKey(id, deps) !== null
}

/**
 * Persist a key for `id` into `cli-credentials.json` (the CLI's writable key store;
 * the desktop app's safeStorage isn't reachable here). Reads-merges-writes the flat
 * `{ "<id>": "<key>" }` map and rewrites the file 0600 so a fresh file — or an
 * existing group/world-readable one — ends up owner-only. Returns the resolved env
 * var name if `id`'s key is currently coming from the environment, so the caller can
 * warn that the env var still shadows what was just written (env wins in cliGetKey).
 */
export function cliSetKey(
  id: string,
  key: string,
  deps: CredentialDeps = {}
): { shadowedByEnv: string | null } {
  const env = deps.env ?? process.env
  const dataDir = deps.dataDir ?? getUserDataDir()
  const path = join(dataDir, 'cli-credentials.json')
  const current = readJsonObject(path)
  current[id] = key
  writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  const envName = envVarCandidates(id).find((name) => env[name])
  return { shadowedByEnv: envName ?? null }
}

/**
 * Remove `id`'s key from `cli-credentials.json`. Returns true if a stored key was
 * removed. A no-op (returns false) when the file is absent, malformed, or has no
 * such entry — nothing to remove and nothing to rewrite.
 */
export function cliRemoveKey(id: string, deps: CredentialDeps = {}): boolean {
  const dataDir = deps.dataDir ?? getUserDataDir()
  const path = join(dataDir, 'cli-credentials.json')
  const current = readJsonObject(path)
  if (!(id in current)) return false
  delete current[id]
  writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  return true
}
