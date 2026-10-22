import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { permissionRuleKey, type PermissionRule } from '@shared/types'
import { writeFileAtomicSync } from './atomic-write'
import { getUserDataDir } from './userData'

/**
 * When each permission rule last decided a call, so Settings can show which rules
 * are still earning their place. Kept in its own file (rule-usage.json) rather
 * than on the rules in settings.json: it changes on every matched call, and a
 * settings save racing a usage write must never drop a rule edit.
 *
 * Keyed by {@link permissionRuleKey}, so it follows a rule through reordering and
 * survives an edit that changes nothing the matcher reads. Writes are debounced
 * and merged with what is on disk (latest timestamp wins per key), since the app
 * and a terminal session may both record into the same file.
 */
export type RuleUsage = Record<string, number>

const FILE = 'rule-usage.json'
/** Cap on stored keys, oldest dropped first: rules come and go, the file should not grow forever. */
const MAX_KEYS = 2000
const FLUSH_MS = 2000

let pending: RuleUsage = {}
let timer: ReturnType<typeof setTimeout> | null = null

function path(): string {
  return join(getUserDataDir(), FILE)
}

function readDisk(): RuleUsage {
  try {
    const raw: unknown = JSON.parse(readFileSync(path(), 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out: RuleUsage = {}
    for (const [k, v] of Object.entries(raw)) if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    return out
  } catch {
    return {}
  }
}

/** Latest timestamp per key across both maps, trimmed to the newest {@link MAX_KEYS}. */
export function mergeUsage(a: RuleUsage, b: RuleUsage): RuleUsage {
  const merged: RuleUsage = { ...a }
  for (const [k, v] of Object.entries(b)) if (!(k in merged) || v > merged[k]) merged[k] = v
  const keys = Object.keys(merged)
  if (keys.length <= MAX_KEYS) return merged
  return Object.fromEntries(
    keys
      .sort((x, y) => merged[y] - merged[x])
      .slice(0, MAX_KEYS)
      .map((k) => [k, merged[k]])
  )
}

/** Write any recorded uses now. Best effort: usage is a hint, never worth an error. */
export function flushRuleUsage(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  if (Object.keys(pending).length === 0) return
  const next = mergeUsage(readDisk(), pending)
  pending = {}
  try {
    writeFileAtomicSync(path(), JSON.stringify(next), 0o600)
  } catch {
    // Unwritable user-data dir: drop it, the next use records again.
  }
}

/** Record that `rule` just decided a call. */
export function noteRuleUsed(rule: PermissionRule, at: number = Date.now()): void {
  pending[permissionRuleKey(rule)] = at
  if (!timer) {
    timer = setTimeout(flushRuleUsage, FLUSH_MS)
    // Never keep a headless run alive just to write a hint.
    timer.unref?.()
  }
}

/** Every recorded use, including ones not yet written. */
export function getRuleUsage(): RuleUsage {
  return mergeUsage(readDisk(), pending)
}

/** Test-only: forget unwritten uses and cancel the pending flush. */
export function resetRuleUsageForTests(): void {
  pending = {}
  if (timer) clearTimeout(timer)
  timer = null
}
