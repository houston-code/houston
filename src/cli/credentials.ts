import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getUserDataDir } from '../main/userData'

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

/** Well-known environment variables per credential id, tried before the generic form. */
const ENV_ALIASES: Record<string, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  // Web-search keys: tavily reuses the legacy bare id (see @shared/search).
  'web-search': ['TAVILY_API_KEY'],
  'web-search:brave': ['BRAVE_API_KEY'],
  'web-search:exa': ['EXA_API_KEY']
}

/** `HOUSTON_API_KEY_<ID>` with the id uppercased and non-alphanumerics collapsed to `_`. */
export function genericEnvVar(id: string): string {
  return `HOUSTON_API_KEY_${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`
}

/** The env var names checked for a credential id, in precedence order. */
export function envVarCandidates(id: string): string[] {
  return [...(ENV_ALIASES[id] ?? []), genericEnvVar(id)]
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
