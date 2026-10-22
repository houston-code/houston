import { safeStorage } from 'electron'
import { secureStorageUnavailableMessage, type SecureStorageStatus } from '@shared/secureStorage'
import { readFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { writeFileAtomicSync } from './atomic-write'
import { join, dirname } from 'node:path'
import type { McpOAuthTokens } from './mcp/oauth'
import { getUserDataDir } from './userData'
import { log } from './logger'

/**
 * Credential storage. Secrets are encrypted with Electron `safeStorage`, which on
 * macOS derives its encryption key from the system Keychain. Only ciphertext touches
 * disk; plaintext secrets never leave the main process and are never sent to the
 * renderer.
 *
 * A provider's credential is either a plain API key or an OAuth token set. Both are
 * stored as a single encrypted JSON blob per provider id, so the file layout doesn't
 * change when a provider switches auth methods.
 *
 * `safeStorage` only offers asynchronous encryption (the synchronous calls are gone in
 * Electron 46), but every reader here is synchronous and sits behind sync seams shared
 * with the CLI. So {@link initSecrets} decrypts the whole store once at startup into an
 * in-memory vault that the getters read. Writes update the vault immediately and are
 * encrypted and persisted in order on a background queue; {@link flushSecrets} waits
 * for it (before exit, and where a caller must report a failed write).
 */

/** A static API key the user pastes in. */
export interface ApiKeyCredential {
  type: 'api-key'
  key: string
}

/**
 * An OAuth token set obtained via an interactive flow. `expiresAt` is epoch
 * milliseconds for the access token; a missing/zero value means "unknown / never
 * checked". MCP-server token sets (minted by `src/main/mcp/oauth.ts`) also carry
 * their client registration and token endpoint so a refresh needs no re-discovery;
 * the provider OAuth flow is still a stub — see `src/main/oauth.ts`.
 */
export interface OAuthCredential {
  type: 'oauth'
  access: string
  refresh: string
  /** Epoch ms when `access` expires, if known. */
  expiresAt?: number
  /** Registered OAuth client id (MCP dynamic registration). */
  clientId?: string
  /** Client secret, when registration issued one. Secret — redacted like tokens. */
  clientSecret?: string
  /** Token endpoint the set was minted at, reused for refresh. */
  tokenEndpoint?: string
  /** RFC 8707 resource indicator the tokens are bound to. */
  resource?: string
  /** Space-separated granted scopes, when reported. */
  scope?: string
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
  // 0600 — owner read/write only.
  writeFileAtomicSync(path, JSON.stringify(data), 0o600)
}

/**
 * Whether a `safeStorage` backend id means weak, hardcoded-key encryption rather
 * than a real OS keyring. Electron's Linux `basic_text` backend encrypts with a
 * well-known key when no Secret Service is available, yet encryption still reports
 * as available — so ciphertext at rest would be trivially reversible. Pure +
 * exported for testing.
 */
export function isWeakEncryptionBackend(platform: NodeJS.Platform, backend: string | null): boolean {
  return platform === 'linux' && backend === 'basic_text'
}

/** The live safeStorage backend id, or null when it can't be determined (non-Linux). */
function selectedBackend(): string | null {
  try {
    return safeStorage.getSelectedStorageBackend()
  } catch {
    return null // not Linux, or an Electron without the API
  }
}

// ---- In-memory vault ----

interface Vault {
  /** False until {@link initSecrets} finishes; reads see an empty store until then. */
  ready: boolean
  /** Whether safeStorage could encrypt when the vault was loaded. */
  available: boolean
  /** Decrypted credentials. An entry that failed to decrypt is absent. */
  keys: Map<string, StoredCredential>
  /** Decrypted header maps per scope. An entry that failed to decrypt is absent. */
  headers: Map<string, Record<string, string>>
}

function emptyVault(): Vault {
  return { ready: false, available: false, keys: new Map(), headers: new Map() }
}

let vault: Vault = emptyVault()

/**
 * The ciphertext each vault entry was decrypted from (or encrypted to), per id/scope:
 * what this process last knew to be on disk. Another Houston process (the desktop app
 * and a terminal session share the store) writes the same file, and comparing against
 * this is how {@link refreshSecretsFromDisk} finds the entries it changed.
 */
let synced: { keys: Map<string, string>; headers: Map<string, string> } = { keys: new Map(), headers: new Map() }
/** Ids / scopes with a write of this process's own still queued: disk is behind memory there. */
const pendingKeyIds = new Map<string, number>()
const pendingHeaderScopes = new Map<string, number>()

function bump(map: Map<string, number>, id: string, by: 1 | -1): void {
  const n = (map.get(id) ?? 0) + by
  if (n > 0) map.set(id, n)
  else map.delete(id)
}

/** Tail of the ordered persist queue; every write chains onto it. */
let writeQueue: Promise<void> = Promise.resolve()
/** First failed write since the last {@link flushSecrets}, reported (and cleared) there. */
let writeError: Error | null = null
/** Writes queued but not yet on disk. */
let pendingWrites = 0
/** Writes ever queued, so a re-sync can tell one came and went while it decrypted. */
let writesQueued = 0

async function encrypt(plaintext: string): Promise<string> {
  return (await safeStorage.encryptStringAsync(plaintext)).toString('base64')
}

/** Decrypt one stored blob, or null when it can no longer be unlocked. */
async function decrypt(stored: string): Promise<{ plaintext: string; reEncrypt: boolean } | null> {
  try {
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(Buffer.from(stored, 'base64'))
    return { plaintext: result, reEncrypt: shouldReEncrypt }
  } catch {
    return null
  }
}

/**
 * Decrypt the on-disk store into the in-memory vault. Call once the app is ready and
 * before anything reads a credential: until it resolves, every getter reports an empty
 * store and every setter throws the "secure storage unavailable" error, which is how
 * the store behaved before the `ready` event under the old synchronous API. Calling it
 * again reloads the vault from disk. Entries safeStorage flags for re-encryption (a
 * rotated key) are rewritten with the current key.
 */
export async function initSecrets(): Promise<void> {
  let available: boolean
  try {
    available = await safeStorage.isAsyncEncryptionAvailable()
  } catch {
    available = false
  }
  const next: Vault = { ready: true, available, keys: new Map(), headers: new Map() }
  const nextSynced = { keys: new Map<string, string>(), headers: new Map<string, string>() }
  const reEncryptKeys: string[] = []
  const reEncryptHeaders: string[] = []
  const stamp = fileStamp()
  if (available) {
    const data = load()
    await Promise.all([
      ...Object.entries(data.keys).map(async ([id, stored]) => {
        nextSynced.keys.set(id, stored)
        const out = await decrypt(stored)
        if (!out) return
        next.keys.set(id, decodeCredential(out.plaintext))
        if (out.reEncrypt) reEncryptKeys.push(id)
      }),
      ...Object.entries(data.headers ?? {}).map(async ([scope, stored]) => {
        nextSynced.headers.set(scope, stored)
        const out = await decrypt(stored)
        const headers = out ? decodeHeaders(out.plaintext) : null
        if (!out || !headers) return
        next.headers.set(scope, headers)
        if (out.reEncrypt) reEncryptHeaders.push(scope)
      })
    ])
  }
  vault = next
  synced = nextSynced
  seenStamp = stamp
  cachedSecretValues = null
  if (available) warnIfWeakBackend()
  for (const id of reEncryptKeys) enqueueKeyWrite(id, next.keys.get(id)!)
  for (const scope of reEncryptHeaders) enqueueHeaderWrite(scope, next.headers.get(scope)!)
}

/** Shortest gap between two checks of the file for another process's changes. */
const SYNC_CHECK_MS = 1_000

/** The store file's mtime and size, or '' when it does not exist. */
function fileStamp(): string {
  try {
    const st = statSync(secretsPath())
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return ''
  }
}

/** The file stamp the vault was last brought up to date with. */
let seenStamp = ''
let lastSyncCheck = 0
let syncing: Promise<void> | null = null

/**
 * Pick up changes another Houston process made to the store, at most once a
 * {@link SYNC_CHECK_MS}: called from the getters, and cheap (one stat) when nothing
 * changed. The re-sync itself runs in the background, so the read that notices a
 * change still sees the previous value; the next one sees the new.
 */
function syncSoon(): void {
  if (!vault.ready || !vault.available) return
  const now = Date.now()
  if (now - lastSyncCheck < SYNC_CHECK_MS) return
  lastSyncCheck = now
  if (fileStamp() === seenStamp) return
  void refreshSecretsFromDisk()
}

/**
 * Bring the vault up to date with the store on disk, decrypting only the entries
 * whose ciphertext changed since this process last saw them. Without it a key saved,
 * a sign-in completed, or an OAuth refresh token rotated in the desktop app stayed
 * invisible to a terminal session already running (and the reverse) until restart,
 * and a rotated refresh token left the other process refreshing with a revoked one.
 * Entries with a write of this process's own still queued are left alone: memory is
 * ahead of disk there. Resolves once the vault reflects what was read.
 */
export function refreshSecretsFromDisk(): Promise<void> {
  if (!vault.ready || !vault.available) return Promise.resolve()
  syncing ??= (async () => {
    try {
      seenStamp = fileStamp()
      const data = load()
      const writesAtStart = writesQueued
      let changed = false
      const syncMap = async <T>(
        onDisk: Record<string, string>,
        seen: Map<string, string>,
        pending: Map<string, number>,
        live: Map<string, T>,
        decode: (plaintext: string) => T | null
      ): Promise<void> => {
        await Promise.all(
          Object.entries(onDisk).map(async ([id, stored]) => {
            if (pending.has(id) || seen.get(id) === stored) return
            const out = await decrypt(stored)
            // A local write started meanwhile: it wins, and the next check re-reads.
            if (pending.has(id) || writesQueued !== writesAtStart) {
              seenStamp = ''
              return
            }
            const value = out ? decode(out.plaintext) : null
            if (value !== null) live.set(id, value)
            else live.delete(id)
            seen.set(id, stored)
            changed = true
          })
        )
        for (const id of [...seen.keys()]) {
          if (id in onDisk || pending.has(id)) continue
          seen.delete(id)
          if (live.delete(id)) changed = true
        }
      }
      await syncMap(data.keys, synced.keys, pendingKeyIds, vault.keys, decodeCredential)
      await syncMap(data.headers ?? {}, synced.headers, pendingHeaderScopes, vault.headers, decodeHeaders)
      if (changed) cachedSecretValues = null
    } finally {
      syncing = null
    }
  })()
  return syncing
}

/**
 * Resolve once every queued write has reached disk. Rejects with the first write that
 * failed since the last flush (memory has already fallen back to what's on disk for that
 * entry, unless a later write replaced it). Await before the process exits, and after a write
 * whose failure the caller has to report.
 */
export async function flushSecrets(): Promise<void> {
  // Writes queued while waiting chain onto a newer tail; keep going until it settles.
  let tail: Promise<void>
  do {
    tail = writeQueue
    await tail
  } while (tail !== writeQueue)
  if (writeError) {
    const e = writeError
    writeError = null
    throw e
  }
}

/**
 * Run one read-modify-write of the file after every earlier write has finished. `apply`
 * returns false when it changed nothing, which skips the write.
 */
function enqueueWrite(
  apply: (data: SecretsFile) => Promise<boolean> | boolean,
  onFailure: () => Promise<void> | void,
  track?: { pending: Map<string, number>; id: string; onPersisted: (data: SecretsFile) => void }
): void {
  pendingWrites++
  writesQueued++
  if (track) bump(track.pending, track.id, 1)
  writeQueue = writeQueue.then(async () => {
    try {
      // Re-read so a write never clobbers entries another Houston process added.
      const data = load()
      if (await apply(data)) persist(data)
      track?.onPersisted(data)
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e))
      writeError ??= err
      log.error(`could not save credentials: ${err.message}`)
      await onFailure()
    } finally {
      pendingWrites--
      if (track) bump(track.pending, track.id, -1)
    }
  })
}

/** Record what a write left on disk for one entry, so a re-sync doesn't take it for a change. */
function keyTracker(id: string): { pending: Map<string, number>; id: string; onPersisted: (data: SecretsFile) => void } {
  return {
    pending: pendingKeyIds,
    id,
    onPersisted: (data) => {
      if (id in data.keys) synced.keys.set(id, data.keys[id])
      else synced.keys.delete(id)
    }
  }
}

function headerTracker(scope: string): { pending: Map<string, number>; id: string; onPersisted: (data: SecretsFile) => void } {
  return {
    pending: pendingHeaderScopes,
    id: scope,
    onPersisted: (data) => {
      const stored = data.headers?.[scope]
      if (stored !== undefined) synced.headers.set(scope, stored)
      else synced.headers.delete(scope)
    }
  }
}

/** Whether a credential write is still waiting to reach disk. */
export function hasPendingSecretWrites(): boolean {
  return pendingWrites > 0
}

function enqueueKeyWrite(id: string, cred: StoredCredential): void {
  enqueueWrite(
    async (data) => {
      data.keys[id] = await encrypt(encodeCredential(cred))
      return true
    },
    async () => {
      // Fall back to what's on disk, unless a later write has replaced the value.
      if (vault.keys.get(id) !== cred) return
      const stored = load().keys[id]
      const out = stored ? await decrypt(stored) : null
      if (vault.keys.get(id) !== cred) return
      if (out) vault.keys.set(id, decodeCredential(out.plaintext))
      else vault.keys.delete(id)
      cachedSecretValues = null
    },
    keyTracker(id)
  )
}

function enqueueHeaderWrite(scope: string, headers: Record<string, string>): void {
  enqueueWrite(
    async (data) => {
      const map = data.headers ?? (data.headers = {})
      map[scope] = await encrypt(JSON.stringify(headers))
      return true
    },
    async () => {
      if (vault.headers.get(scope) !== headers) return
      const stored = load().headers?.[scope]
      const out = stored ? await decrypt(stored) : null
      const previous = out ? decodeHeaders(out.plaintext) : null
      if (vault.headers.get(scope) !== headers) return
      if (previous) vault.headers.set(scope, previous)
      else vault.headers.delete(scope)
      cachedSecretValues = null
    },
    headerTracker(scope)
  )
}

let warnedWeakBackend = false

function warnIfWeakBackend(): void {
  // safeStorage reports encryption as available even for Linux's hardcoded-key
  // `basic_text` backend, which is NOT real at-rest encryption. Warn once so we
  // never silently imply keys are strongly encrypted when the ciphertext is
  // reversible with a well-known key (the 0600 file mode is then the only guard).
  if (!warnedWeakBackend && isWeakEncryptionBackend(process.platform, selectedBackend())) {
    warnedWeakBackend = true
    log.warn(
      'safeStorage has no OS keyring available and is using the insecure "basic_text" backend: ' +
        'stored credentials are encrypted with a well-known key, not strongly encrypted at rest. ' +
        'Unlock or install a Secret Service keyring (e.g. gnome-keyring / kwallet) for real encryption.'
    )
  }
}

/**
 * Whether credentials can be stored right now. On macOS a denied Keychain prompt makes
 * this false until Houston restarts (Electron caches the failed key lookup for the
 * process, and the vault keeps the answer it got at startup), which is what the
 * renderer's "Restart Houston" prompt keys off.
 */
export function secureStorageStatus(): SecureStorageStatus {
  return { available: vault.available, platform: process.platform }
}

function assertEncryptionAvailable(): void {
  if (!vault.available) {
    throw new Error(secureStorageUnavailableMessage(process.platform))
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

/** Decode a decrypted header map, keeping only string values; null if it isn't one. */
function decodeHeaders(plaintext: string): Record<string, string> | null {
  try {
    const parsed = JSON.parse(plaintext) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v
    }
    return out
  } catch {
    return null
  }
}

/** Main-process only. Returns the decrypted credential, or null if none/undecryptable. */
export function getCredential(providerId: string): StoredCredential | null {
  syncSoon()
  return vault.keys.get(providerId) ?? null
}

/**
 * Store a credential (API key or OAuth token set) for a provider. It's readable at once;
 * the encrypted copy reaches disk shortly after (see {@link flushSecrets}).
 */
export function setCredential(providerId: string, credential: StoredCredential): void {
  assertEncryptionAvailable()
  vault.keys.set(providerId, credential)
  cachedSecretValues = null
  enqueueKeyWrite(providerId, credential)
}

export function setKey(providerId: string, plaintext: string): void {
  setCredential(providerId, { type: 'api-key', key: plaintext })
}

export function deleteKey(providerId: string): void {
  if (vault.keys.delete(providerId)) cachedSecretValues = null
  enqueueWrite(
    (data) => {
      if (!(providerId in data.keys)) return false
      delete data.keys[providerId]
      return true
    },
    () => {},
    keyTracker(providerId)
  )
}

/** True when *some* ciphertext is stored for this provider, decryptable or not. */
export function hasStoredKey(providerId: string): boolean {
  return vault.keys.has(providerId) || Boolean(load().keys[providerId])
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

// ---- MCP-server OAuth token sets ----
//
// Stored in the same encrypted `keys` map as provider credentials, under a
// namespaced id ("mcp-oauth:<serverId>") that can never collide with a provider id
// (provider ids carry no colon). Reusing the credential blob means enumeration,
// redaction, and the atomic-persist path all cover these tokens for free.

/** Secrets-store id under which an MCP server's OAuth token set is kept. */
export function mcpOAuthKeyId(serverId: string): string {
  return `mcp-oauth:${serverId}`
}

/** Main-process only. The stored MCP OAuth token set, or null if none/unusable. */
export function getMcpOAuthTokens(serverId: string): McpOAuthTokens | null {
  const cred = getCredential(mcpOAuthKeyId(serverId))
  if (!cred || cred.type !== 'oauth') return null
  // A refresh needs the client id + token endpoint; a blob without them (or without
  // an access token) can't be used, so report "not signed in".
  if (!cred.access || !cred.clientId || !cred.tokenEndpoint) return null
  return {
    access: cred.access,
    refresh: cred.refresh || undefined,
    expiresAt: cred.expiresAt,
    scope: cred.scope,
    clientId: cred.clientId,
    clientSecret: cred.clientSecret,
    tokenEndpoint: cred.tokenEndpoint,
    resource: cred.resource
  }
}

/** Store an MCP OAuth token set; `null` signs the server out. */
export function setMcpOAuthTokens(serverId: string, tokens: McpOAuthTokens | null): void {
  if (!tokens) {
    deleteKey(mcpOAuthKeyId(serverId))
    return
  }
  setCredential(mcpOAuthKeyId(serverId), {
    type: 'oauth',
    access: tokens.access,
    refresh: tokens.refresh ?? '',
    expiresAt: tokens.expiresAt,
    scope: tokens.scope,
    clientId: tokens.clientId,
    clientSecret: tokens.clientSecret,
    tokenEndpoint: tokens.tokenEndpoint,
    resource: tokens.resource
  })
}

// ---- Custom-header secrets (provider / MCP server auth headers) ----
//
// A header map is stored as a single encrypted JSON blob per `scope`
// ("provider:<id>" / "mcp:<id>"; see @shared/types header-scope helpers), mirroring
// how credentials are stored per provider id. Header VALUES can be bearer tokens, so
// this keeps them out of settings.json (cleartext) and out of the renderer.

/** Main-process only. Decrypted header map for a scope, or `{}` if none/undecryptable. */
export function getSecretHeaders(scope: string): Record<string, string> {
  syncSoon()
  const headers = vault.headers.get(scope)
  return headers ? { ...headers } : {}
}

/**
 * Store a header map for a scope. An empty map removes the entry, so a provider/server
 * that no longer has any custom headers leaves no stale ciphertext.
 */
export function setSecretHeaders(scope: string, headers: Record<string, string>): void {
  if (Object.keys(headers).length === 0) {
    deleteSecretHeaders(scope)
    return
  }
  assertEncryptionAvailable()
  const copy = { ...headers }
  vault.headers.set(scope, copy)
  cachedSecretValues = null
  enqueueHeaderWrite(scope, copy)
}

export function deleteSecretHeaders(scope: string): void {
  if (vault.headers.delete(scope)) cachedSecretValues = null
  enqueueWrite(
    (data) => {
      if (!data.headers || !(scope in data.headers)) return false
      delete data.headers[scope]
      return true
    },
    () => {},
    headerTracker(scope)
  )
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

/** Cached result of {@link collectSecretValues}; dropped whenever the vault changes. */
let cachedSecretValues: string[] | null = null

/**
 * Main-process only. Every plaintext secret value this install holds — provider API
 * keys, OAuth access/refresh tokens, and secret-shaped custom-header values — for the
 * redactor to strip from tool results and logs (see `agent/redact.ts`). Best-effort:
 * undecryptable entries are skipped and the whole thing degrades to `[]` rather than
 * throwing. Cached until the next credential/header write.
 */
export function collectSecretValues(): string[] {
  syncSoon()
  if (cachedSecretValues) return cachedSecretValues
  const out = new Set<string>()
  try {
    for (const cred of vault.keys.values()) {
      const values =
        cred.type === 'api-key' ? [cred.key] : [cred.access, cred.refresh, cred.clientSecret ?? '']
      for (const v of values) {
        if (v && v.length >= MIN_CREDENTIAL_LEN) out.add(v)
      }
    }
    for (const headers of vault.headers.values()) {
      for (const v of Object.values(headers)) {
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
