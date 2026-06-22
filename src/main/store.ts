import { app } from 'electron'
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { AppSettings, ProviderConfig } from '@shared/types'
import { defaultSettings, SETTINGS_SCHEMA_VERSION } from '@shared/defaults'
import { hasKey } from './secrets'

/**
 * Persistent app settings (everything except secrets). Stored as JSON in userData.
 * `hasKey` on each provider is recomputed from the secrets store on every read and
 * is never persisted here.
 */

let cache: AppSettings | null = null

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function migrate(raw: Partial<AppSettings>): AppSettings {
  const base = defaultSettings()
  const merged: AppSettings = {
    ...base,
    ...raw,
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    providers: Array.isArray(raw.providers) && raw.providers.length > 0 ? raw.providers : base.providers
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
    providers: settings.providers.map((p) => ({ ...p, hasKey: false }))
  }
  writeFileSync(tmp, JSON.stringify(toWrite, null, 2), 'utf8')
  renameSync(tmp, path)
}

/** Attach the live `hasKey` flag from the secrets store. */
function withKeyFlags(settings: AppSettings): AppSettings {
  return {
    ...settings,
    providers: settings.providers.map((p) => ({ ...p, hasKey: hasKey(p.id) }))
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

/** Look up a provider by id from current settings. */
export function getProvider(providerId: string): ProviderConfig | undefined {
  return getSettings().providers.find((p) => p.id === providerId)
}

/** Push a workspace path to the front of the recents list (deduped, capped). */
export function rememberWorkspace(path: string): AppSettings {
  const current = getSettings()
  const recents = [path, ...current.recentWorkspaces.filter((p) => p !== path)].slice(0, 10)
  return updateSettings({ recentWorkspaces: recents })
}
