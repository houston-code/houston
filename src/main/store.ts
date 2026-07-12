import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdirSync,
  statSync,
  realpathSync
} from 'node:fs'
import { join, dirname } from 'node:path'
import { getUserDataDir } from './userData'
import type { AppSettings, McpServerConfig, PermissionRule, ProviderConfig } from '@shared/types'
import {
  REDACTED_HEADER_VALUE,
  isRedactedHeaderValue,
  mcpHeaderScope,
  providerHeaderScope
} from '@shared/types'
import {
  backfillDefaultModels,
  defaultSettings,
  SETTINGS_SCHEMA_VERSION,
  stripBuiltInModelLabels
} from '@shared/defaults'
import { SEARCH_PROVIDERS } from '@shared/search'

/**
 * Persistent app settings (everything except secrets). Stored as JSON in userData.
 * `hasKey` on each provider is recomputed from the credential store on every read
 * and is never persisted here. Custom-header VALUES are likewise never persisted here
 * — they can be bearer tokens, so they live in the encrypted secret store (moved out
 * here via the injected header-secret seam) and only their keys, with redacted values,
 * survive round-trips through disk and the renderer.
 */

/**
 * Injected "is a usable credential stored for this id?" check, used to attach the
 * live `hasKey` flags. A seam rather than an import: `./secrets` pulls in electron
 * (safeStorage), which would make every consumer of the store Electron-bound. The
 * Electron shell wires `secrets.hasKey` at startup (wireAgentHost.ts); the
 * standalone CLI wires its env-var/credential-file check.
 */
let hasKeyFn: ((id: string) => boolean) | null = null

/** Bind the credential-presence check. Call once during startup, before any read. */
export function configureHasKey(fn: (id: string) => boolean): void {
  hasKeyFn = fn
}

function hasKey(id: string): boolean {
  if (!hasKeyFn) {
    throw new Error(
      'Credential check not configured — call configureHasKey() during startup before reading settings.'
    )
  }
  return hasKeyFn(id)
}

/**
 * Injected store for custom-header VALUES (a provider/MCP-server bearer token). A seam
 * for the same reason as {@link configureHasKey}: the real backing is `./secrets`
 * (electron safeStorage), which the store must not import so it stays portable. The
 * Electron shell wires the safeStorage-backed maps (wireAgentHost.ts); the standalone
 * CLI wires its env/file source. `get` returns `{}` for an unknown scope.
 */
export interface HeaderSecretStore {
  get(scope: string): Record<string, string>
  set(scope: string, headers: Record<string, string>): void
  remove(scope: string): void
}
let headerSecrets: HeaderSecretStore | null = null

/** Bind the header-secret store. Call once during startup, before any settings read. */
export function configureHeaderSecrets(store: HeaderSecretStore): void {
  headerSecrets = store
}

function requireHeaderSecrets(): HeaderSecretStore {
  if (!headerSecrets) {
    throw new Error(
      'Header-secret store not configured — call configureHeaderSecrets() during startup before reading settings.'
    )
  }
  return headerSecrets
}

let cache: AppSettings | null = null

function settingsPath(): string {
  return join(getUserDataDir(), 'settings.json')
}

function migrate(raw: Partial<AppSettings>): AppSettings {
  const base = defaultSettings()
  const fromVersion = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 0
  let providers =
    Array.isArray(raw.providers) && raw.providers.length > 0 ? raw.providers : base.providers
  // v2: backfill built-in default models (e.g. the GPT-5 family) added since this
  // install last wrote its settings. Version-gated so it runs once per upgrade —
  // a model the user deletes afterwards stays deleted instead of reappearing.
  if (fromVersion < 2) providers = backfillDefaultModels(providers)
  // v3: seed the newly-added Claude Fable model into installs that already migrated to
  // v2. Scoped to just that id — a full backfill here would re-add other defaults the
  // user has since deleted, breaking the "stays deleted" guarantee above.
  if (fromVersion < 3) providers = backfillDefaultModels(providers, ['claude-fable-5'])
  // v4: model display names are now derived from the id (one convention per provider),
  // so drop the stale hardcoded labels older versions seeded — they no longer matched
  // what a live Fetch returns and made a provider's list read inconsistently. Also seed
  // the current OpenAI GPT-5.x line (scoped to the new ids, per the "stays deleted" rule
  // above — older gpt-5/gpt-4o defaults the user kept are left untouched).
  if (fromVersion < 4) {
    const newOpenAiModels = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4']
    providers = stripBuiltInModelLabels(backfillDefaultModels(providers, newOpenAiModels))
  }
  const merged: AppSettings = {
    ...base,
    ...raw,
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    providers
  }
  return merged
}

function loadFromDisk(): AppSettings {
  const path = settingsPath()
  if (!existsSync(path)) return defaultSettings()
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<AppSettings>
    return migrate(parsed)
  } catch {
    return defaultSettings()
  }
}

// ---- Custom-header secrets ----
//
// Header values can be bearer tokens, so they're handled like the API key: the real
// values live in the encrypted secrets store, keyed by scope. On disk (settings.json)
// and to the renderer only the header KEYS survive, with the values redacted. The
// secrets store is the source of truth for request-building (providers/index.ts,
// mcp/manager.ts read it directly).

/** On-disk redaction: keep the header keys, blank the values. */
function redactHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
  if (!headers) return headers
  return Object.fromEntries(Object.keys(headers).map((k) => [k, '']))
}

/** Renderer mask: keep the header keys, show a stored value as the mask placeholder. */
function maskHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
  if (!headers) return headers
  return Object.fromEntries(Object.keys(headers).map((k) => [k, REDACTED_HEADER_VALUE]))
}

function sameHeaders(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a)
  return ak.length === Object.keys(b).length && ak.every((k) => a[k] === b[k])
}

/**
 * Reconcile one scope's headers against the secret store and return the on-disk
 * redacted form (keys kept, values blanked). A redacted incoming value — the renderer
 * mask or the on-disk blank — means "unchanged": carry the stored secret forward. Any
 * other value is a freshly entered secret (or legacy cleartext read off disk) that
 * replaces it; `migrated` flags that so the caller can rewrite a legacy file.
 *
 * The on-disk key set (`diskKeys`) is tracked separately from the secret map: the
 * profile is shared with the standalone CLI, whose store can't read the desktop's
 * encrypted values, so a redacted key with no locally-resolvable secret is preserved
 * on disk rather than dropped — otherwise the CLI saving settings would strip the
 * desktop's header keys. A header is only removed by dropping its key entirely.
 */
function reconcileScope(
  scope: string,
  incoming: Record<string, string> | undefined
): { headers?: Record<string, string>; migrated: boolean } {
  if (!incoming) return { headers: incoming, migrated: false }
  const store = requireHeaderSecrets()
  const existing = store.get(scope)
  const secretMap: Record<string, string> = {}
  const diskKeys: string[] = []
  let sawPlaintext = false
  for (const [k, v] of Object.entries(incoming)) {
    diskKeys.push(k) // the key stays visible on disk / to the renderer either way
    if (isRedactedHeaderValue(v)) {
      if (existing[k] !== undefined) secretMap[k] = existing[k]
    } else {
      secretMap[k] = v
      sawPlaintext = true
    }
  }
  try {
    if (Object.keys(secretMap).length === 0) {
      // Guard the delete on `existing` being non-empty so a transient decrypt failure
      // (which also yields {}) can't wipe recoverable ciphertext.
      if (Object.keys(existing).length) store.remove(scope)
    } else if (!sameHeaders(secretMap, existing)) {
      store.set(scope, secretMap)
    }
  } catch {
    // Secret store unavailable (e.g. no OS keyring): don't strip or corrupt anything —
    // leave the incoming config as-is. persist() still keeps values off disk and the
    // renderer still sees them masked.
    return { headers: incoming, migrated: false }
  }
  return {
    headers: diskKeys.length ? Object.fromEntries(diskKeys.map((k) => [k, ''])) : undefined,
    migrated: sawPlaintext
  }
}

/**
 * Pull every provider's and MCP server's secret header values into the encrypted
 * store, returning settings whose header values are redacted for disk. `migrated`
 * flags that cleartext was present (a legacy file), so the caller rewrites it.
 */
function extractHeaderSecrets(settings: AppSettings): { settings: AppSettings; migrated: boolean } {
  let migrated = false
  const take = (scope: string, headers?: Record<string, string>): Record<string, string> | undefined => {
    const r = reconcileScope(scope, headers)
    if (r.migrated) migrated = true
    return r.headers
  }
  const providers: ProviderConfig[] = settings.providers.map((p) => ({
    ...p,
    headers: take(providerHeaderScope(p.id), p.headers)
  }))
  const mcpServers: McpServerConfig[] | undefined = settings.mcpServers?.map((s) => ({
    ...s,
    headers: take(mcpHeaderScope(s.id), s.headers)
  }))
  return {
    settings: { ...settings, providers, mcpServers: mcpServers ?? settings.mcpServers },
    migrated
  }
}

function persist(settings: AppSettings): void {
  const path = settingsPath()
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  // Don't persist the derived hasKey flag, and never write custom-header values in
  // cleartext — their secrets live in the encrypted store (moved out by
  // extractHeaderSecrets before we get here); this strips the values as a safety net
  // so a stray real value can't leak to disk even if that step is bypassed.
  const toWrite: AppSettings = {
    ...settings,
    providers: settings.providers.map((p) => ({ ...p, hasKey: false, headers: redactHeaders(p.headers) })),
    mcpServers: settings.mcpServers?.map((s) => ({ ...s, headers: redactHeaders(s.headers) })),
    searchKeyStatus: undefined // derived, recomputed on read
  }
  // 0600 — owner read/write only. Matches secrets.json: even with header secrets moved
  // out, settings.json still holds workspace paths, prompts, and MCP endpoints.
  writeFileSync(tmp, JSON.stringify(toWrite, null, 2), { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, path)
}

/**
 * Attach the live `hasKey` flag from the secrets store, and mask every custom-header
 * value so a stored secret never reaches the renderer — only the keys, with a mask
 * placeholder marking that a value exists.
 */
function withKeyFlags(settings: AppSettings): AppSettings {
  return {
    ...settings,
    providers: settings.providers.map((p) => ({
      ...p,
      hasKey: hasKey(p.id),
      headers: maskHeaders(p.headers)
    })),
    mcpServers: settings.mcpServers?.map((s) => ({ ...s, headers: maskHeaders(s.headers) })),
    searchKeyStatus: Object.fromEntries(SEARCH_PROVIDERS.map((p) => [p.id, hasKey(p.keyId)]))
  }
}

export function getSettings(): AppSettings {
  if (!cache) {
    const { settings, migrated } = extractHeaderSecrets(loadFromDisk())
    cache = settings
    // A legacy settings.json with cleartext header values: rewrite it now (0600, values
    // stripped) so the plaintext doesn't linger on disk until the next explicit save.
    if (migrated) persist(cache)
  }
  return withKeyFlags(cache)
}

export function saveSettings(next: AppSettings): AppSettings {
  const { settings } = extractHeaderSecrets({ ...next, schemaVersion: SETTINGS_SCHEMA_VERSION })
  cache = settings
  persist(cache)
  return withKeyFlags(cache)
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  return saveSettings({ ...getSettings(), ...patch })
}

/**
 * Persist a permission rule from an in-prompt "Always allow" / "Always deny" choice.
 * Prepended so it wins over the user's existing (often broader) rules, and deduped so
 * repeated clicks don't pile up identical rules. Returns the updated settings (or the
 * current ones unchanged when the rule already exists).
 */
export function addPermissionRule(rule: PermissionRule): AppSettings {
  const current = getSettings().permissionRules ?? []
  if (
    current.some((r) => r.action === rule.action && r.tool === rule.tool && r.match === rule.match)
  ) {
    return getSettings()
  }
  return updateSettings({ permissionRules: [rule, ...current] })
}

/** Look up a provider by id from current settings. */
export function getProvider(providerId: string): ProviderConfig | undefined {
  return getSettings().providers.find((p) => p.id === providerId)
}

/** True when `path` is still an existing directory we can open as a workspace. */
function workspaceExists(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Push a workspace path to the front of the recents list (deduped, capped). Dead
 * entries (a folder that no longer exists — e.g. a torn-down worktree) are pruned
 * as we go, so the recents self-heal and can't seed a new chat with a phantom repo.
 * The freshly-added `path` is kept unconditionally; callers pass a live directory.
 */
export function rememberWorkspace(path: string): AppSettings {
  const current = getSettings()
  const recents = [
    path,
    ...current.recentWorkspaces.filter((p) => p !== path && workspaceExists(p))
  ].slice(0, 10)
  return updateSettings({ recentWorkspaces: recents })
}

/**
 * Realpath-normalize a workspace path so the "don't ask again" list matches the
 * same folder regardless of how it's spelled (e.g. macOS's `/tmp` → `/private/tmp`
 * symlink, or a symlinked project dir). Falls back to the raw path when it can't be
 * resolved (a since-deleted folder), which still round-trips consistently.
 */
function normalizeWorkspacePath(workspace: string): string {
  try {
    return realpathSync(workspace)
  } catch {
    return workspace
  }
}

/**
 * Whether the user opted out of the first-write "Initialize git repository" prompt
 * for this workspace ("Don't ask again for this folder"). Compared realpath-normalized
 * so it matches the path however it's spelled.
 */
export function isGitInitDismissed(workspace: string): boolean {
  if (!workspace) return false
  const target = normalizeWorkspacePath(workspace)
  return (getSettings().gitInitDismissed ?? []).includes(target)
}

/**
 * Record that the user opted out of the first-write git-init prompt for this
 * workspace. Realpath-normalized and deduped; a no-op (returns current settings)
 * when already present or given no path.
 */
export function dismissGitInit(workspace: string): AppSettings {
  if (!workspace) return getSettings()
  const target = normalizeWorkspacePath(workspace)
  const current = getSettings().gitInitDismissed ?? []
  if (current.includes(target)) return getSettings()
  return updateSettings({ gitInitDismissed: [...current, target] })
}

/**
 * Drop recent-workspace entries whose directory no longer exists. Run once at
 * startup so a folder deleted since the last launch (e.g. a worktree removed with
 * its chat) can't become the default workspace for the next new chat. Persists
 * only when something actually changed.
 */
export function pruneRecentWorkspaces(): AppSettings {
  const current = getSettings()
  const live = current.recentWorkspaces.filter(workspaceExists)
  if (live.length === current.recentWorkspaces.length) return current
  return updateSettings({ recentWorkspaces: live })
}
