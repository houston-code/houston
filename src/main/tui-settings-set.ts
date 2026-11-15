import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AppSettings } from '@shared/types'
import { autoExtendTurnsEnabled } from '@shared/defaults'
import { compactionMode } from '@shared/compactionThreshold'
import { DEFAULT_EGRESS_ALLOWLIST } from '@shared/egress'
import { PREFERENCE_DEFAULTS, type ParsedImport } from '@shared/settingsPortable'
import { DEFAULT_SEARCH_PROVIDER_ID, getSearchProviderInfo, SEARCH_PROVIDERS } from '@shared/search'
import { resolveAddDir } from './sessionFlags'
import type { Painter } from './tui'
import { stripControlChars } from './tui-wrap'

/**
 * `/settings set|get|unset|add|remove|export|import|reset|search-key` in the
 * terminal. Only the settings in {@link SETTABLE} can be changed, each checked
 * against its own type and range (the same bounds the desktop's fields hold it to)
 * before anything is written. API keys never go through `set`: they are entered
 * hidden with `/settings search-key`, as `/login` takes a provider's.
 *
 * Every change is a patch merged into settings as they are on disk at that moment
 * (`updateSettings` re-reads the shared settings.json first), so the desktop app
 * and the terminal never write a stale copy over each other.
 */

export type SettingsCommand =
  | { op: 'overview' }
  | { op: 'page'; page: string }
  /** No key: every setting `set` can change, with its value. */
  | { op: 'get'; key?: string }
  | { op: 'set'; key: string; value: string }
  /** Back to the default (removes the setting). */
  | { op: 'unset'; key: string }
  /** A list setting (`additionalRoots`): add or remove one entry. */
  | { op: 'add' | 'remove'; key: string; value: string }
  | { op: 'export' | 'import'; path: string }
  | { op: 'reset' }
  /** Enter a web search provider's API key, hidden. */
  | { op: 'search-key'; provider?: string }
  | { op: 'usage'; message: string }

export const SETTINGS_USAGE =
  'usage: /settings [page] · get [key] · set <key> <value> · unset <key> · add|remove additionalRoots <path> · export|import <path> · reset · search-key [provider]'

/** Read the words after `/settings`. Anything that isn't a verb names a page. */
export function parseSettingsCommand(arg: string): SettingsCommand {
  const a = arg.trim()
  if (!a) return { op: 'overview' }
  const m = /^(\S+)(?:\s+(\S+))?(?:\s+([\s\S]*))?$/.exec(a)!
  const verb = m[1].toLowerCase()
  const key = m[2]
  const rest = (m[3] ?? '').trim()
  const usage = (what: string): SettingsCommand => ({ op: 'usage', message: `usage: /settings ${what}` })
  switch (verb) {
    case 'get':
    case 'show':
      if (rest) return usage('get [key]')
      return key ? { op: 'get', key } : { op: 'get' }
    case 'set': {
      if (!key) return usage('set <key> <value>')
      // A key name with nothing after it is an unfinished command, never a clear.
      if (!rest) return usage(`set ${key} <value> (/settings unset ${key} restores the default)`)
      return { op: 'set', key, value: rest }
    }
    case 'unset':
    case 'default':
      return key && !rest ? { op: 'unset', key } : usage('unset <key>')
    case 'add':
    case 'remove':
    case 'rm': {
      const value = rest
      if (!key || !value) return usage(`${verb === 'rm' ? 'remove' : verb} additionalRoots <path>`)
      return { op: verb === 'add' ? 'add' : 'remove', key, value }
    }
    case 'export':
    case 'import': {
      const path = [key, rest].filter(Boolean).join(' ')
      return path ? { op: verb, path } : usage(`${verb} <path>`)
    }
    case 'reset':
      return key ? usage('reset') : { op: 'reset' }
    case 'search-key':
      if (rest) return usage('search-key [provider]')
      return key ? { op: 'search-key', provider: key } : { op: 'search-key' }
    default:
      return { op: 'page', page: a }
  }
}

/** What a setting check needs beyond the settings: where `~` and relative paths go. */
export interface SetContext {
  cwd: string
  home?: string
}

type Outcome = { patch: Partial<AppSettings>; note?: string } | { error: string }

interface Spec {
  /** The desktop page it is on, for `/settings get`'s grouping. */
  page: string
  /** What it does and what it takes, for `/settings get <key>`. */
  help: string
  show: (s: AppSettings) => string
  set?: (raw: string, s: AppSettings, ctx: SetContext) => Outcome
  /** The patch that puts it back to the default. */
  unset: (s: AppSettings) => Partial<AppSettings>
  /** A list setting: add or remove one entry. */
  add?: (raw: string, s: AppSettings, ctx: SetContext) => Outcome
  remove?: (raw: string, s: AppSettings, ctx: SetContext) => Outcome
}

type Key = keyof AppSettings

const BOOL_TRUE = new Set(['on', 'true', 'yes', '1'])
const BOOL_FALSE = new Set(['off', 'false', 'no', '0'])

/** `value` for a set value, or `value (default)` for an unset one. */
function shown(v: unknown, fallback: unknown): string {
  const text = (x: unknown): string => (typeof x === 'boolean' ? (x ? 'on' : 'off') : String(x))
  if (v === undefined) return fallback === undefined ? '(default)' : `${text(fallback)} (default)`
  return text(v)
}

function fallbackFor(key: Key): unknown {
  return Object.hasOwn(PREFERENCE_DEFAULTS, key) ? (PREFERENCE_DEFAULTS as Record<string, unknown>)[key] : undefined
}

function bool(key: Key, page: string, help: string): Spec {
  return {
    page,
    help: `${help} (on | off)`,
    show: (s) => shown(s[key], fallbackFor(key)),
    set: (raw) => {
      const v = raw.toLowerCase()
      if (BOOL_TRUE.has(v)) return { patch: { [key]: true } }
      if (BOOL_FALSE.has(v)) return { patch: { [key]: false } }
      return { error: `${key} is on or off` }
    },
    unset: () => ({ [key]: undefined })
  }
}

/**
 * A number from `min` (and up to `max`, when given). `integer` takes whole numbers
 * only. A leading `$` is allowed for a dollar amount.
 */
function num(key: Key, page: string, help: string, o: { min: number; max?: number; integer?: boolean }): Spec {
  const range = o.max === undefined ? `${o.min} or more` : `${o.min} to ${o.max}`
  return {
    page,
    help: `${help} (${o.integer ? 'a whole number, ' : ''}${range})`,
    show: (s) => shown(s[key], fallbackFor(key)),
    set: (raw) => {
      const t = raw.replace(/^\$/, '').replace(/_/g, '')
      const ok = o.integer ? /^\d+$/.test(t) : /^\d+(\.\d+)?$/.test(t)
      const n = Number(t)
      if (!ok || !Number.isFinite(n) || !Number.isSafeInteger(Math.floor(n)) || n < o.min || (o.max !== undefined && n > o.max)) {
        return { error: `${key} takes ${o.integer ? 'a whole number, ' : 'a number, '}${range}` }
      }
      return { patch: { [key]: n } }
    },
    unset: () => ({ [key]: undefined })
  }
}

function choice(key: Key, page: string, help: string, values: readonly string[]): Spec {
  return {
    page,
    help: `${help} (${values.join(' | ')})`,
    show: (s) => shown(s[key], fallbackFor(key)),
    set: (raw) => {
      const v = raw.toLowerCase()
      return values.includes(v) ? { patch: { [key]: v } } : { error: `${key} is one of ${values.join(', ')}` }
    },
    unset: () => ({ [key]: undefined })
  }
}

/** Longest text a single-line text setting takes from the terminal. */
export const MAX_TEXT_SETTING_CHARS = 20_000

function text(key: Key, page: string, help: string): Spec {
  return {
    page,
    help,
    show: (s) => {
      const v = s[key]
      if (typeof v !== 'string' || !v) return '(empty)'
      const one = stripControlChars(v.replace(/\s+/g, ' '))
      return one.length > 80 ? `${one.slice(0, 79)}… (${v.length} characters)` : one
    },
    set: (raw) =>
      raw.length > MAX_TEXT_SETTING_CHARS
        ? { error: `${key} is at most ${MAX_TEXT_SETTING_CHARS} characters` }
        : { patch: { [key]: raw } },
    unset: () => ({ [key]: undefined })
  }
}

/** The proxy URL with any password in it hidden. */
export function maskProxyUrl(url: string): string {
  try {
    const u = new URL(url)
    if (u.password) u.password = '***'
    return stripControlChars(u.toString().replace(/\/$/, url.endsWith('/') ? '/' : ''))
  } catch {
    return stripControlChars(url.replace(/\/\/([^/@:]*):[^/@]*@/, '//$1:***@'))
  }
}

function expandHome(p: string, home: string): string {
  return p === '~' || p.startsWith('~/') ? join(home, p.slice(1)) : p
}

/**
 * Everything `/settings set` can change. Keys are the settings.json names; each
 * check matches the desktop field that edits it.
 */
export const SETTABLE: Readonly<Record<string, Spec>> = {
  // Agent Behavior
  systemPromptExtra: text('systemPromptExtra', 'agent', 'Extra instructions added to every conversation'),
  compactionThreshold: {
    page: 'agent',
    help: 'When the conversation is compacted: auto (from the model\'s window), off, a share of the window (1% to 100%), or a token count (1000 or more)',
    show: (s) => {
      switch (compactionMode(s)) {
        case 'off':
          return 'off'
        case 'percent':
          return `${s.compactionThresholdPercent}%`
        case 'tokens':
          return `${s.compactionThreshold} tokens`
        default:
          return 'auto (default)'
      }
    },
    set: (raw) => {
      const v = raw.toLowerCase().replace(/_/g, '').replace(/\s*tokens?$/, '')
      if (v === 'auto') return { patch: { compactionThreshold: undefined, compactionThresholdPercent: undefined } }
      if (v === 'off') return { patch: { compactionThreshold: 0, compactionThresholdPercent: undefined } }
      const pct = /^(\d+)\s*%$/.exec(v)
      if (pct) {
        const n = Number(pct[1])
        if (n >= 1 && n <= 100) return { patch: { compactionThresholdPercent: n, compactionThreshold: undefined } }
      } else if (/^\d+$/.test(v) && Number(v) >= 1000 && Number.isSafeInteger(Number(v))) {
        return { patch: { compactionThreshold: Number(v), compactionThresholdPercent: undefined } }
      }
      return { error: 'compactionThreshold is auto, off, a share like 70%, or a token count of 1000 or more' }
    },
    unset: () => ({ compactionThreshold: undefined, compactionThresholdPercent: undefined })
  },
  shellOutputMaxBytes: num('shellOutputMaxBytes', 'agent', "Bytes of one command's output kept", { min: 1000, integer: true }),
  maxIterations: {
    ...num('maxIterations', 'agent', 'Steps per turn', { min: 1, integer: true }),
    // Pin the keep-going switch to what it was, as the desktop field does, so setting
    // a cap never silently turns extension off (see autoExtendTurnsEnabled).
    set: (raw, s, ctx) => {
      const r = num('maxIterations', 'agent', '', { min: 1, integer: true }).set!(raw, s, ctx)
      return 'error' in r ? r : { patch: { ...r.patch, autoExtendTurns: autoExtendTurnsEnabled(s) } }
    }
  },
  autoExtendTurns: {
    ...bool('autoExtendTurns', 'agent', 'Keep going past the step cap while the turn makes progress'),
    show: (s) => (s.autoExtendTurns === undefined ? `${autoExtendTurnsEnabled(s) ? 'on' : 'off'} (default)` : shown(s.autoExtendTurns, undefined))
  },
  maxIterationsCeiling: num('maxIterationsCeiling', 'agent', 'Most steps a turn can reach, however productive', { min: 1, integer: true }),
  subagentHistoryMb: num('subagentHistoryMb', 'agent', 'Subagent history kept per chat, in MB', { min: 0, max: 1024 }),
  costCeilingUsd: num('costCeilingUsd', 'agent', "Remind the model to wrap up past this turn cost in US dollars (0: off)", { min: 0 }),
  maxCostUsd: num('maxCostUsd', 'agent', 'Stop a turn once its cost reaches this many US dollars (0: no limit)', { min: 0 }),
  stallDetection: bool('stallDetection', 'agent', 'Detect unproductive loops'),
  doneEvidenceNote: bool('doneEvidenceNote', 'agent', 'Before finishing, tell the model what is still open'),
  verifyOnStop: bool('verifyOnStop', 'agent', 'Run the verification command when the model finishes after changing files'),
  verifyCommand: text('verifyCommand', 'agent', 'The verification command (empty: the suggested one in full auto, nothing otherwise)'),
  reasoningSummary: choice('reasoningSummary', 'agent', 'How reasoning is summarized (OpenAI Responses models)', ['auto', 'concise', 'detailed', 'none']),
  verbosity: choice('verbosity', 'agent', 'How long replies run (OpenAI Responses models)', ['low', 'medium', 'high']),
  suggestNextPrompt: bool('suggestNextPrompt', 'agent', 'Suggest a next message when a turn ends (a small extra request)'),
  // Providers & Models
  proxyUrl: {
    page: 'models',
    help: 'HTTP proxy for model, MCP and web search requests (an http:// or https:// URL; unset: the HTTPS_PROXY environment variable)',
    show: (s) => (s.proxyUrl ? maskProxyUrl(s.proxyUrl) : '(none)'),
    set: (raw) =>
      /^https?:\/\/[^\s/]+/i.test(raw) && !/\s/.test(raw)
        ? { patch: { proxyUrl: raw } }
        : { error: 'proxyUrl is an http:// or https:// URL' },
    unset: () => ({ proxyUrl: undefined })
  },
  // Tools
  searchProvider: {
    page: 'tools',
    help: `Web search provider (${SEARCH_PROVIDERS.map((p) => p.id).join(' | ')}); its key: /settings search-key`,
    show: (s) => {
      const p = getSearchProviderInfo(s.searchProvider ?? DEFAULT_SEARCH_PROVIDER_ID)
      const key = s.searchKeyStatus?.[p.id] ? 'key set' : 'no key'
      return `${p.id}${s.searchProvider === undefined ? ' (default)' : ''}, ${key}`
    },
    set: (raw) => {
      const v = raw.toLowerCase()
      return SEARCH_PROVIDERS.some((p) => p.id === v)
        ? { patch: { searchProvider: v } }
        : { error: `searchProvider is one of ${SEARCH_PROVIDERS.map((p) => p.id).join(', ')}` }
    },
    unset: () => ({ searchProvider: undefined })
  },
  lspEnabled: bool('lspEnabled', 'tools', 'Language servers (default: on where the sandbox confines them)'),
  formatOnSave: bool('formatOnSave', 'tools', "Run the project's formatter on each edited file"),
  diagnosticsOnSave: bool('diagnosticsOnSave', 'tools', 'Report new errors in each edited file'),
  // General
  desktopNotifications: bool('desktopNotifications', 'general', 'Desktop notifications from the app'),
  appBadge: bool('appBadge', 'general', "The app icon's badge"),
  backgroundWake: bool('backgroundWake', 'general', 'Continue a turn when background work it waits on finishes'),
  // Permissions
  webReads: {
    ...choice('webReads', 'permissions', 'Reading a web page: ask first, or allow without asking', ['ask', 'allow']),
    set: (raw) => {
      const v = raw.toLowerCase()
      if (v === 'ask') return { patch: { webReads: 'ask' } }
      if (v === 'allow') {
        return { patch: { webReads: 'allow' }, note: 'the agent now reads web pages without asking; their text is still fenced as untrusted' }
      }
      return { error: 'webReads is ask or allow' }
    }
  },
  // Workspace
  additionalRoots: {
    page: 'workspace',
    help: 'Folders the agent may read and write in every session (add|remove additionalRoots <path>)',
    show: (s) => {
      const roots = s.additionalRoots ?? []
      return roots.length ? roots.map((r, i) => `${i + 1}. ${stripControlChars(r)}`).join('  ') : '(none)'
    },
    unset: () => ({ additionalRoots: undefined }),
    add: (raw, s, ctx) => {
      const r = resolveAddDir(expandHome(raw.trim(), ctx.home ?? homedir()), ctx.cwd)
      if ('error' in r) return { error: `additionalRoots: ${r.error}` }
      const roots = s.additionalRoots ?? []
      if (roots.includes(r.dir)) return { error: `${r.dir} is already there` }
      return {
        patch: { additionalRoots: [...roots, r.dir] },
        note: `the agent may now read and write ${r.dir} in every session`
      }
    },
    remove: (raw, s, ctx) => {
      const roots = s.additionalRoots ?? []
      const v = raw.trim()
      const n = /^\d+$/.test(v) ? Number(v) : NaN
      let at = Number.isInteger(n) && n >= 1 && n <= roots.length ? n - 1 : -1
      if (at < 0) {
        const r = resolveAddDir(expandHome(v, ctx.home ?? homedir()), ctx.cwd)
        const want = 'dir' in r ? r.dir : v
        at = roots.findIndex((d) => d === v || d === want)
      }
      if (at < 0) return { error: `additionalRoots has no ${JSON.stringify(v)}; /settings get additionalRoots lists them` }
      return { patch: { additionalRoots: roots.filter((_, i) => i !== at) }, note: `removed ${roots[at]}` }
    }
  }
}

/** The settable key a typed name means, ignoring case; null for anything else. */
export function settableKey(name: string): string | null {
  const n = name.toLowerCase()
  return Object.keys(SETTABLE).find((k) => k.toLowerCase() === n) ?? null
}

/** A name that holds a credential: never set from a typed line. */
const SECRET_NAME = /key|token|secret|password|credential/i

function unknownKey(name: string): string {
  const shownName = stripControlChars(name)
  if (SECRET_NAME.test(name)) {
    return `· API keys are never set with /settings set: /login takes a provider's, /settings search-key a web search provider's (both hidden)`
  }
  return `· ${shownName} isn't a setting the terminal changes; /settings get lists the ones it does`
}

/** A change to apply: the patch to merge, and what to tell the user. */
export type SettingChange = { patch: Partial<AppSettings>; message: string } | { error: string }

/**
 * Check and turn `/settings set|unset|add|remove` into a patch, against the settings
 * as they are now. Never writes; the caller merges the patch.
 */
export function settingChange(
  cmd: Extract<SettingsCommand, { op: 'set' | 'unset' | 'add' | 'remove' }>,
  settings: AppSettings,
  ctx: SetContext
): SettingChange {
  const key = settableKey(cmd.key)
  if (!key) return { error: unknownKey(cmd.key) }
  const spec = SETTABLE[key]
  if (cmd.op === 'unset') {
    const patch = spec.unset(settings)
    return { patch, message: `· ${key} → ${spec.show({ ...settings, ...patch })}` }
  }
  const fn = cmd.op === 'set' ? spec.set : cmd.op === 'add' ? spec.add : spec.remove
  if (!fn) {
    return {
      error:
        cmd.op === 'set'
          ? `· ${key} is a list: /settings add ${key} <path>, /settings remove ${key} <path|n>`
          : `· ${key} isn't a list; /settings set ${key} <value>`
    }
  }
  const r = fn(cmd.value, settings, ctx)
  if ('error' in r) return { error: `· ${stripControlChars(r.error)}` }
  const after = spec.show({ ...settings, ...r.patch })
  return { patch: r.patch, message: `· ${key} → ${after}${r.note ? `\n· ${stripControlChars(r.note)}` : ''}` }
}

const PAGE_TITLES: Readonly<Record<string, string>> = {
  agent: 'Agent Behavior',
  models: 'Providers & Models',
  tools: 'Tools',
  general: 'General',
  permissions: 'Permissions',
  workspace: 'Workspace'
}

/** `/settings get [key]`: one setting with what it takes, or every one by page. */
export function renderSettingValues(
  settings: AppSettings,
  paint: Painter,
  key?: string,
  extra?: { verifySuggestion?: { command: string; source: string } | null }
): string {
  if (key !== undefined) {
    const k = settableKey(key)
    if (!k) return paint(unknownKey(key), 'yellow')
    const spec = SETTABLE[k]
    const lines = [`${paint(k, 'cyan')} = ${spec.show(settings)}`, paint(`  ${spec.help}`, 'dim')]
    if (k === 'verifyCommand' && extra?.verifySuggestion) {
      const s = extra.verifySuggestion
      const inUse = (settings.verifyCommand ?? '').trim() === s.command
      lines.push(
        paint(
          `  For this project: ${stripControlChars(s.command)} (from ${stripControlChars(s.source)})${inUse ? ', in use' : ''}`,
          'dim'
        )
      )
    }
    return lines.join('\n')
  }
  const keys = Object.keys(SETTABLE)
  const width = Math.max(...keys.map((k) => k.length))
  const lines: string[] = []
  for (const [page, title] of Object.entries(PAGE_TITLES)) {
    const here = keys.filter((k) => SETTABLE[k].page === page)
    if (!here.length) continue
    lines.push(paint(title, 'bold'))
    for (const k of here) lines.push(`  ${paint(k.padEnd(width), 'cyan')}  ${SETTABLE[k].show(settings)}`)
  }
  lines.push(paint('  /settings set <key> <value> changes one; /settings get <key> says what it takes.', 'dim'))
  return lines.join('\n')
}

/**
 * The sandbox egress lists, web reads, and extra folders, for `/permissions`: what
 * the agent may reach beyond the rules. Egress is shown, not edited, here.
 */
export function renderAccessSummary(settings: AppSettings, paint: Painter): string {
  const egress = settings.sandboxEgress ?? {}
  const list = (xs: readonly string[] | undefined): string =>
    xs && xs.length ? xs.map((x) => stripControlChars(x)).join(', ') : '(none)'
  const lines = [paint('Beyond the rules', 'bold')]
  lines.push(`  web reads:      ${settings.webReads === 'allow' ? 'allow without asking' : 'ask first'}  (/settings set webReads ask|allow)`)
  const roots = settings.additionalRoots ?? []
  lines.push(
    `  extra folders:  ${roots.length ? roots.map((r) => stripControlChars(r)).join(', ') : '(none)'}  (/settings add|remove additionalRoots <path>)`
  )
  if (egress.mode === 'all') {
    lines.push(`  sandbox egress: ${paint('all domains', 'yellow')}: a command granted network can reach any host`)
  } else {
    lines.push(`  sandbox egress: allowlist (${DEFAULT_EGRESS_ALLOWLIST.length} built-in development hosts, plus the added ones)`)
    lines.push(`    added:  ${list(egress.allow)}`)
    lines.push(`    denied: ${list(egress.deny)}`)
  }
  lines.push(paint('  Sandbox egress is edited in the desktop app: Settings > Permissions.', 'dim'))
  return lines.join('\n')
}

/** What an import replaces and what deserves a second look, before the y/N. */
export function importSummary(parsed: Extract<ParsedImport, { ok: true }>): string[] {
  const lines = [`· this import replaces your ${parsed.keys.join(', ')}`]
  const allow = parsed.settings.permissionRules?.filter((r) => r.action === 'allow').length ?? 0
  const hooks = parsed.settings.hooks?.length ?? 0
  const warn = [
    allow ? `${allow} ${allow === 1 ? 'rule that allows' : 'rules that allow'} calls without asking` : '',
    hooks ? `${hooks} ${hooks === 1 ? 'hook that runs' : 'hooks that run'} shell commands` : ''
  ].filter(Boolean)
  if (warn.length) lines.push(`· it includes ${warn.join(' and ')}: import only a file you trust`)
  if (parsed.settings.approvalPolicy) lines.push(`· it sets the approval mode for new chats to ${parsed.settings.approvalPolicy}`)
  if (parsed.settings.sandboxEgress?.mode === 'all') lines.push('· it lets sandboxed commands reach every domain once granted network')
  if (parsed.settings.webReads === 'allow') lines.push('· it lets the agent read web pages without asking')
  if (parsed.ignored.length) lines.push(`· not imported (not preferences): ${parsed.ignored.map((k) => stripControlChars(k)).join(', ')}`)
  return lines
}
