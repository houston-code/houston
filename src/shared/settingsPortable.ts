import type { AppSettings, Hook, PermissionRule } from './types'
import { APPROVAL_POLICIES, HOOK_EVENTS } from './types'
import {
  DEFAULT_ITERATION_CEILING,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_SHELL_OUTPUT_MAX_BYTES
} from './defaults'
import { DEFAULT_SEARCH_PROVIDER_ID } from './search'
import { DEFAULT_SUBAGENT_HISTORY_MB } from './subagents'
import { parseRulesText } from './permissionRulesText'

/**
 * The user's preferences: the settings that mean the same on any machine and hold
 * no secret. Each maps to the value Houston behaves as having when the setting is
 * absent, which is what "Modified" compares against and what a reset restores (by
 * removing the setting, so a later change of default reaches the user too). The
 * approval mode travels too, but has no fixed default; see NO_FIXED_DEFAULT.
 *
 * Deliberately not here: providers and MCP servers (endpoints tied to keys and
 * tokens, whose stored headers are masked), and anything naming this machine's
 * folders (additional folders, trusted folders, recents).
 */
export const PREFERENCE_DEFAULTS = {
  webReads: 'ask',
  permissionRules: [],
  hooks: [],
  systemPromptExtra: '',
  compactionThreshold: undefined,
  shellOutputMaxBytes: DEFAULT_SHELL_OUTPUT_MAX_BYTES,
  maxIterations: DEFAULT_MAX_ITERATIONS,
  autoExtendTurns: true,
  maxIterationsCeiling: DEFAULT_ITERATION_CEILING,
  costCeilingUsd: 0,
  stallDetection: true,
  verifyOnStop: false,
  verifyCommand: '',
  subagentHistoryMb: DEFAULT_SUBAGENT_HISTORY_MB,
  reasoningSummary: 'auto',
  verbosity: 'medium',
  searchProvider: DEFAULT_SEARCH_PROVIDER_ID,
  lspEnabled: undefined,
  lspServers: [],
  formatOnSave: false,
  diagnosticsOnSave: undefined,
  desktopNotifications: true,
  theme: 'system',
  htmlVisuals: false,
  keybindings: {},
  sandboxEgress: undefined
} satisfies Partial<AppSettings>

/** A preference with a fixed default: one "Modified" compares against and Reset restores. */
export type ResettableKey = keyof typeof PREFERENCE_DEFAULTS

/**
 * Preferences that move with an export but have no fixed default. The approval mode
 * a fresh install starts in depends on the machine (full auto where the OS sandbox
 * confines commands, ask where it can't; see freshInstallApprovalPolicy), which only
 * main knows, so it is never marked Modified and never reset: a reset to a guessed
 * default could quietly change how much the agent may do without asking.
 */
export const NO_FIXED_DEFAULT = ['approvalPolicy'] as const

export type PreferenceKey = ResettableKey | (typeof NO_FIXED_DEFAULT)[number]

export const PREFERENCE_KEYS: PreferenceKey[] = [
  ...NO_FIXED_DEFAULT,
  ...(Object.keys(PREFERENCE_DEFAULTS) as ResettableKey[])
]

/** Whether any of `keys` differs from what Houston does when it is unset. */
export function isModified(settings: AppSettings, keys: readonly ResettableKey[]): boolean {
  return keys.some((k) => {
    const v = settings[k]
    return v !== undefined && JSON.stringify(v) !== JSON.stringify(PREFERENCE_DEFAULTS[k])
  })
}

/** `settings` with `keys` back to their defaults. */
export function resetPreferences(settings: AppSettings, keys: readonly ResettableKey[]): AppSettings {
  const next: Record<string, unknown> = { ...settings }
  for (const k of keys) delete next[k]
  return next as unknown as AppSettings
}

/**
 * Preferences that a reset of everything restores. Rules and hooks are the user's own
 * work, so they stay, as does anything without a fixed default (the approval mode).
 */
export const RESETTABLE_PREFERENCES = (Object.keys(PREFERENCE_DEFAULTS) as ResettableKey[]).filter(
  (k) => k !== 'permissionRules' && k !== 'hooks' && k !== 'lspServers'
)

export const EXPORT_FORMAT = 'houston-settings'

/** The preferences as a file to keep or move to another machine. */
export function exportPreferences(settings: AppSettings, now: Date = new Date()): string {
  const prefs: Record<string, unknown> = {}
  for (const k of PREFERENCE_KEYS) if (settings[k] !== undefined) prefs[k] = settings[k]
  return `${JSON.stringify({ format: EXPORT_FORMAT, version: 1, exportedAt: now.toISOString(), settings: prefs }, null, 2)}\n`
}

export type ParsedImport =
  | { ok: true; settings: Partial<AppSettings>; keys: PreferenceKey[]; ignored: string[] }
  | { ok: false; error: string }

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * Type checks per preference; a value failing its check rejects the file.
 * Permission rules and hooks are validated on their own, more strictly, below.
 */
const CHECKS: Record<Exclude<PreferenceKey, 'permissionRules' | 'hooks'>, (v: unknown) => boolean> = {
  approvalPolicy: (v) => typeof v === 'string' && (APPROVAL_POLICIES as readonly string[]).includes(v),
  webReads: (v) => v === 'ask' || v === 'allow',
  systemPromptExtra: (v) => typeof v === 'string',
  compactionThreshold: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0,
  shellOutputMaxBytes: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 1000,
  maxIterations: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 1,
  autoExtendTurns: (v) => typeof v === 'boolean',
  maxIterationsCeiling: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 1,
  costCeilingUsd: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0,
  stallDetection: (v) => typeof v === 'boolean',
  verifyOnStop: (v) => typeof v === 'boolean',
  verifyCommand: (v) => typeof v === 'string',
  subagentHistoryMb: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1024,
  reasoningSummary: (v) => v === 'auto' || v === 'concise' || v === 'detailed' || v === 'none',
  verbosity: (v) => v === 'low' || v === 'medium' || v === 'high',
  searchProvider: (v) => typeof v === 'string',
  lspEnabled: (v) => typeof v === 'boolean',
  lspServers: (v) =>
    Array.isArray(v) &&
    v.every((e) => isObject(e) && typeof e.id === 'string' && typeof e.command === 'string' && Array.isArray(e.extensions)),
  formatOnSave: (v) => typeof v === 'boolean',
  diagnosticsOnSave: (v) => typeof v === 'boolean',
  desktopNotifications: (v) => typeof v === 'boolean',
  theme: (v) => v === 'system' || v === 'dark' || v === 'light',
  htmlVisuals: (v) => typeof v === 'boolean',
  keybindings: (v) => isObject(v) && Object.values(v).every((b) => b === null || typeof b === 'string'),
  sandboxEgress: (v) =>
    isObject(v) &&
    (v.mode === undefined || v.mode === 'allowlist' || v.mode === 'all') &&
    (v.allow === undefined || (Array.isArray(v.allow) && v.allow.every((d) => typeof d === 'string'))) &&
    (v.deny === undefined || (Array.isArray(v.deny) && v.deny.every((d) => typeof d === 'string')))
}

function parseHooks(v: unknown): Hook[] | null {
  if (!Array.isArray(v)) return null
  const out: Hook[] = []
  for (const h of v) {
    if (!isObject(h) || typeof h.command !== 'string' || typeof h.matcher !== 'string') return null
    if (!(HOOK_EVENTS as string[]).includes(h.event as string)) return null
    out.push({ event: h.event as Hook['event'], matcher: h.matcher, command: h.command })
  }
  return out
}

/**
 * Read an exported preferences file. Strict: a wrong format, an unknown version,
 * or a value of the wrong type rejects the whole file rather than importing part of
 * it. Fields that are not preferences (a hand-added provider, say) are ignored and
 * reported, never imported.
 */
export function parsePreferencesImport(text: string): ParsedImport {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: 'This file is not valid JSON.' }
  }
  if (!isObject(raw) || raw.format !== EXPORT_FORMAT || !isObject(raw.settings)) {
    return { ok: false, error: 'This is not a Houston settings export.' }
  }
  if (raw.version !== 1) return { ok: false, error: 'This export is from a newer version of Houston.' }
  const settings: Record<string, unknown> = {}
  const keys: PreferenceKey[] = []
  const ignored: string[] = []
  for (const [k, v] of Object.entries(raw.settings)) {
    if (!(PREFERENCE_KEYS as string[]).includes(k)) {
      ignored.push(k)
      continue
    }
    const key = k as PreferenceKey
    if (key === 'permissionRules') {
      const parsed = parseRulesText(JSON.stringify(v))
      if (!parsed.ok) return { ok: false, error: `Permission rules: ${parsed.error}` }
      settings[key] = parsed.rules satisfies PermissionRule[]
    } else if (key === 'hooks') {
      const hooks = parseHooks(v)
      if (!hooks) return { ok: false, error: 'Hooks: each needs an event, a matcher, and a command.' }
      settings[key] = hooks
    } else {
      if (!CHECKS[key](v)) return { ok: false, error: `"${key}" has a value Houston does not accept.` }
      settings[key] = v
    }
    keys.push(key)
  }
  return { ok: true, settings: settings as Partial<AppSettings>, keys, ignored }
}
