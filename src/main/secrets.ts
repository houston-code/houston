import { safeStorage } from 'electron'
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { getUserDataDir } from './userData'

/**
 * Credential storage. Secrets are encrypted with Electron `safeStorage`, which on
 * macOS derives its encryption key from the system Keychain. Only ciphertext touches
 * disk; plaintext secrets never leave the main process and are never sent to the
 * renderer.
 *
 * A provider's credential is either a plain API key or an OAuth token set. Both are
 * stored as a single encrypted JSON blob per provider id, so the file layout doesn't
 * change when a provider switches auth methods.
 */

/** A static API key the user pastes in. */
export interface ApiKeyCredential {
  type: 'api-key'
  key: string
}

/**
 * An OAuth token set obtained via an interactive flow. `expiresAt` is epoch
 * milliseconds for the access token; a missing/zero value means "unknown / never
 * checked". The live flow that mints these is not implemented yet — see
 * `src/main/oauth.ts`.
 */
export interface OAuthCredential {
  type: 'oauth'
  access: string
  refresh: string
  /** Epoch ms when `access` expires, if known. */
  expiresAt?: number
}

export type StoredCredential = ApiKeyCredential | OAuthCredential

interface SecretsFile {
  // providerId -> base64(ciphertext of a JSON-encoded StoredCredential)
  keys: Record<string, string>
  // scope ("provider:<id>" | "mcp:<id>") -> base64(ciphertext of a JSON header map).
  // Custom-header values can be bearer tokens, so they're encrypted here rather than
  // persisted in cleartext in settings.json. See store.ts for how they're moved out.
  headers?: Record<string, string>
}

function secretsPath(): string {
  return join(getUserDataDir(), 'secrets.json')
}

function load(): SecretsFile {
  const path = secretsPath()
  if (!existsSync(path)) return { keys: {} }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SecretsFile>
    return { keys: parsed.keys ?? {}, headers: parsed.headers ?? {} }
  } catch {
    return { keys: {} }
  }
}

function persist(data: SecretsFile): void {
  const path = secretsPath()
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  // 0600 — owner read/write only.
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 })
  renameSync(tmp, path)
  // Any credential/header change invalidates the redactor's cached value list.
  cachedSecretValues = null
}

function assertEncryptionAvailable(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'OS encryption (Keychain) is unavailable, so credentials cannot be stored securely.'
    )
  }
}

/**
 * Decode the decrypted plaintext into a `StoredCredential`. For back-compat, a bare
 * (non-JSON, or JSON without a `type` discriminant) string is treated as a plain API
 * key — that's how keys were stored before the credential generalization.
 */
function decodeCredential(plaintext: string): StoredCredential {
  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext)
  } catch {
    return { type: 'api-key', key: plaintext }
  }
  if (parsed && typeof parsed === 'object' && 'type' in parsed) {
    const cred = parsed as { type?: unknown }
    if (cred.type === 'api-key' || cred.type === 'oauth') {
      return parsed as StoredCredential
    }
  }
  // JSON that isn't a recognized credential shape: fall back to treating the raw
  // plaintext as an API key so a legacy key that happens to be valid JSON still works.
  return { type: 'api-key', key: plaintext }
}

function encodeCredential(cred: StoredCredential): string {
  return JSON.stringify(cred)
}

/** Main-process only. Returns the decrypted credential, or null if none/undecryptable. */
export function getCredential(providerId: string): StoredCredential | null {
  const stored = load().keys[providerId]
  if (!stored) return null
  try {
    assertEncryptionAvailable()
    const plaintext = safeStorage.decryptString(Buffer.from(stored, 'base64'))
    return decodeCredential(plaintext)
  } catch {
    return null
  }
}

/** Encrypt and persist a credential (API key or OAuth token set) for a provider. */
export function setCredential(providerId: string, credential: StoredCredential): void {
  assertEncryptionAvailable()
  const data = load()
  const encrypted = safeStorage.encryptString(encodeCredential(credential))
  data.keys[providerId] = encrypted.toString('base64')
  persist(data)
}

export function setKey(providerId: string, plaintext: string): void {
  setCredential(providerId, { type: 'api-key', key: plaintext })
}

export function deleteKey(providerId: string): void {
  const data = load()
  if (providerId in data.keys) {
    delete data.keys[providerId]
    persist(data)
  }
}

/** True when *some* ciphertext is stored for this provider, decryptable or not. */
export function hasStoredKey(providerId: string): boolean {
  return Boolean(load().keys[providerId])
}

/**
 * True when a *usable* credential is stored — ciphertext exists AND it decrypts with
 * the current OS encryption key. A credential that's present on disk but can no longer
 * be unlocked (e.g. the Keychain item's access changed after an app re-sign/update)
 * returns false, so the "key set" signal the UI and model selection rely on matches
 * what an agent run can actually retrieve.
 */
export function hasKey(providerId: string): boolean {
  return getCredential(providerId) !== null
}

/**
 * Main-process only. Returns the decrypted API key, or null if none/undecryptable.
 *
 * If the stored credential is an OAuth token set rather than an API key, this returns
 * the OAuth access token, so callers that only understand a bearer string keep working
 * once a provider moves to OAuth.
 */
export function getKey(providerId: string): string | null {
  const cred = getCredential(providerId)
  if (!cred) return null
  return cred.type === 'api-key' ? cred.key : cred.access
}

// ---- Custom-header secrets (provider / MCP server auth headers) ----
//
// A header map is stored as a single encrypted JSON blob per `scope`
// ("provider:<id>" / "mcp:<id>"; see @shared/types header-scope helpers), mirroring
// how credentials are stored per provider id. Header VALUES can be bearer tokens, so
// this keeps them out of settings.json (cleartext) and out of the renderer.

/** Main-process only. Decrypted header map for a scope, or `{}` if none/undecryptable. */
export function getSecretHeaders(scope: string): Record<string, string> {
  const stored = load().headers?.[scope]
  if (!stored) return {}
  try {
    assertEncryptionAvailable()
    const plaintext = safeStorage.decryptString(Buffer.from(stored, 'base64'))
    const parsed = JSON.parse(plaintext) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Encrypt and persist a header map for a scope. An empty map removes the entry, so a
 * provider/server that no longer has any custom headers leaves no stale ciphertext.
 */
export function setSecretHeaders(scope: string, headers: Record<string, string>): void {
  const data = load()
  const map = data.headers ?? (data.headers = {})
  if (Object.keys(headers).length === 0) {
    if (!(scope in map)) return
    delete map[scope]
  } else {
    assertEncryptionAvailable()
    map[scope] = safeStorage.encryptString(JSON.stringify(headers)).toString('base64')
  }
  persist(data)
}

export function deleteSecretHeaders(scope: string): void {
  const data = load()
  if (data.headers && scope in data.headers) {
    delete data.headers[scope]
    persist(data)
  }
}

// ---- Secret enumeration (for redaction) ----

/**
 * Minimum length for a stored credential value to be worth redacting. Real API keys
 * and OAuth tokens are far longer; this only guards a pathological short value from
 * becoming an over-eager exact-match against tool output.
 */
const MIN_CREDENTIAL_LEN = 8

/**
 * Secret-shaped opaque tokens inside a custom-header VALUE, worth redacting by exact
 * match. Unlike API keys, the header store holds *every* custom header the user added —
 * innocuous ones (`Content-Type: application/json`) included — so redacting a short or
 * common value everywhere it appears in tool output would corrupt legitimate content.
 * A header value is often `Scheme token` (e.g. `Bearer <jwt>`) or a bare token, so we
 * take each whitespace-delimited run long enough to be a credential rather than a scheme
 * word or a common value. The `Bearer` prefix isn't secret; the long run after it is.
 */
const MIN_HEADER_TOKEN_LEN = 20
function secretTokensFromHeader(value: string): string[] {
  return value.split(/\s+/).filter((t) => t.length >= MIN_HEADER_TOKEN_LEN)
}

/** Cached result of {@link collectSecretValues}; dropped on any write via {@link persist}. */
let cachedSecretValues: string[] | null = null

/**
 * Main-process only. Every plaintext secret value this install holds — provider API
 * keys, OAuth access/refresh tokens, and secret-shaped custom-header values — for the
 * redactor to strip from tool results and logs (see `agent/redact.ts`). Best-effort:
 * undecryptable entries are skipped and the whole thing degrades to `[]` rather than
 * throwing. Cached until the next credential/header write.
 */
export function collectSecretValues(): string[] {
  if (cachedSecretValues) return cachedSecretValues
  const out = new Set<string>()
  try {
    const data = load()
    for (const providerId of Object.keys(data.keys)) {
      const cred = getCredential(providerId)
      if (!cred) continue
      const values = cred.type === 'api-key' ? [cred.key] : [cred.access, cred.refresh]
      for (const v of values) {
        if (v && v.length >= MIN_CREDENTIAL_LEN) out.add(v)
      }
    }
    for (const scope of Object.keys(data.headers ?? {})) {
      for (const v of Object.values(getSecretHeaders(scope))) {
        for (const tok of secretTokensFromHeader(v)) out.add(tok)
      }
    }
  } catch {
    // Never let secret enumeration break a run; a partial/empty list just means less
    // redaction, not a crash.
  }
  cachedSecretValues = [...out]
  return cachedSecretValues
}
