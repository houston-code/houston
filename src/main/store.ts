import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { getUserDataDir } from './userData'
import type { AppSettings, PermissionRule, ProviderConfig } from '@shared/types'
import { backfillDefaultModels, defaultSettings, SETTINGS_SCHEMA_VERSION } from '@shared/defaults'
import { SEARCH_PROVIDERS } from '@shared/search'
import { hasKey } from './secrets'

/**
 * Persistent app settings (everything except secrets). Stored as JSON in userData.
 * `hasKey` on each provider is recomputed from the secrets store on every read and
 * is never persisted here.
 */

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

function persist(settings: AppSettings): void {
  const path = settingsPath()
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  // Don't persist the derived hasKey flag.
  const toWrite: AppSettings = {
    ...settings,
    providers: settings.providers.map((p) => ({ ...p, hasKey: false })),
    searchKeyStatus: undefined // derived, recomputed on read
  }
  writeFileSync(tmp, JSON.stringify(toWrite, null, 2), 'utf8')
  renameSync(tmp, path)
}

/** Attach the live `hasKey` flag from the secrets store. */
function withKeyFlags(settings: AppSettings): AppSettings {
  return {
    ...settings,
    providers: settings.providers.map((p) => ({ ...p, hasKey: hasKey(p.id) })),
    searchKeyStatus: Object.fromEntries(SEARCH_PROVIDERS.map((p) => [p.id, hasKey(p.keyId)]))
  }
}

export function getSettings(): AppSettings {
  if (!cache) cache = loadFromDisk()
  return withKeyFlags(cache)
}

export function saveSettings(next: AppSettings): AppSettings {
  cache = { ...next, schemaVersion: SETTINGS_SCHEMA_VERSION }
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
