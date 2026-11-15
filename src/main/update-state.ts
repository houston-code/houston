import { readFileSync, mkdirSync } from 'node:fs'
import { writeFileAtomicSync } from './atomic-write'
import { join, dirname } from 'node:path'
import { highlightsFor, type WhatsNew } from '@shared/update'
import { shouldShowWhatsNew } from './update-policy'
import { getUserDataDir } from './userData'

/**
 * Tiny persisted record of the app version the user last ran, used to detect an
 * upgrade (and show the "What's new" popup) on the next launch. Kept separate
 * from user-facing settings (src/main/store.ts) because it's internal bookkeeping,
 * not a setting — and so it stays out of the schema-migrated AppSettings surfaced
 * to the renderer.
 *
 * The desktop app and the interactive terminal keep their own record
 * (`lastSeenVersion`, `lastSeenTerminalVersion`), so each shows the note once after an
 * upgrade, whichever is opened first.
 */

interface UpdateState {
  lastSeenVersion?: string
  lastSeenTerminalVersion?: string
}

type Key = keyof UpdateState

function defaultPath(): string {
  return join(getUserDataDir(), 'update-state.json')
}

function readState(path: string): UpdateState {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as UpdateState) : {}
  } catch {
    // Missing or unreadable file → treat as a fresh install.
    return {}
  }
}

/** The version recorded on the previous run, or null if none (fresh install). */
export function readLastSeenVersion(path: string = defaultPath(), key: Key = 'lastSeenVersion'): string | null {
  const v = readState(path)[key]
  return typeof v === 'string' ? v : null
}

/**
 * Record the version now running, written atomically (tmp + rename). The other
 * client's record in the same file is kept.
 */
export function writeLastSeenVersion(version: string, path: string = defaultPath(), key: Key = 'lastSeenVersion'): void {
  const state: UpdateState = {}
  for (const [k, v] of Object.entries(readState(path))) {
    if ((k === 'lastSeenVersion' || k === 'lastSeenTerminalVersion') && typeof v === 'string') state[k] = v
  }
  state[key] = version
  mkdirSync(dirname(path), { recursive: true })
  writeFileAtomicSync(path, JSON.stringify(state, null, 2))
}

/**
 * The terminal's one-time "What's new" after an upgrade: the bundled highlights for
 * `current` when the terminal last ran an older version, else null. Records `current`
 * either way, so it shows once. A first run (nothing recorded) shows nothing, as in the
 * desktop app.
 */
export function takeTerminalWhatsNew(
  current: string,
  path: string = defaultPath(),
  highlightsOf: (version: string) => string | null = highlightsFor
): WhatsNew | null {
  const lastSeen = readLastSeenVersion(path, 'lastSeenTerminalVersion')
  const highlights = shouldShowWhatsNew(lastSeen, current) ? highlightsOf(current) : null
  if (lastSeen !== current) {
    try {
      writeLastSeenVersion(current, path, 'lastSeenTerminalVersion')
    } catch {
      // Not recorded: the note may show again next launch, which beats crashing.
    }
  }
  return highlights ? { version: current, highlights } : null
}
