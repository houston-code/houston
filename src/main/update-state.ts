import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { getUserDataDir } from './userData'

/**
 * Tiny persisted record of the app version the user last ran, used to detect an
 * upgrade (and show the "What's new" popup) on the next launch. Kept separate
 * from user-facing settings (src/main/store.ts) because it's internal bookkeeping,
 * not a setting — and so it stays out of the schema-migrated AppSettings surfaced
 * to the renderer.
 */

interface UpdateState {
  lastSeenVersion?: string
}

function defaultPath(): string {
  return join(getUserDataDir(), 'update-state.json')
}

/** The version recorded on the previous run, or null if none (fresh install). */
export function readLastSeenVersion(path: string = defaultPath()): string | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as UpdateState
    return typeof parsed.lastSeenVersion === 'string' ? parsed.lastSeenVersion : null
  } catch {
    // Missing or unreadable file → treat as a fresh install.
    return null
  }
}

/** Record the version now running, written atomically (tmp + rename). */
export function writeLastSeenVersion(version: string, path: string = defaultPath()): void {
  const state: UpdateState = { lastSeenVersion: version }
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
  renameSync(tmp, path)
}
