import { isReasoningEffort, REASONING_EFFORTS, type ReasoningEffort } from '@shared/agent'
import { DEFAULT_REASONING_EFFORT } from '@shared/defaults'
import { resolveModelArg } from '@shared/modelArg'
import { APPROVAL_POLICIES, parseApprovalPolicy, type AppSettings, type ApprovalPolicy } from '@shared/types'
import { NOTIFY_MODES, type NotifyMode } from './tui-notify'
import { stripControlChars } from './tui-wrap'

/**
 * `/config`: the settings the terminal understands, read and changed in one place.
 * Pure: the key list, parsing `/config key=value`, the next value Enter cycles to,
 * and the patch a settings-only key saves. The driver applies the terminal keys
 * through the same code as their own commands (/theme, /vim, /notify, ...), so a
 * value set here behaves exactly as if that command had set it.
 *
 * Only plain preferences are listed. Nothing here reads or writes an API key, a
 * header, an environment value or any other secret: /login is the way to keys.
 */

export type ConfigKeyName =
  | 'theme'
  | 'vim'
  | 'verbose'
  | 'thoughts'
  | 'notify'
  | 'reduce-motion'
  | 'screen-reader'
  | 'model'
  | 'effort'
  | 'approval'
  | 'desktop-notifications'
  | 'background-wake'
  | 'memory'
  | 'usage-limit-wait'

/** What this session holds live (a launch flag can differ from the saved setting). */
export interface ConfigLive {
  theme: string
  verbose: boolean
  reasoningDisplay: 'show' | 'summary' | 'hide'
  notifyMode: NotifyMode
  reduceMotion: boolean
  screenReader: boolean
}

export interface ConfigContext {
  settings: AppSettings
  /** The terminal color theme names. */
  themes: readonly string[]
}

export interface ConfigKeySpec {
  key: ConfigKeyName
  /** Other names accepted for the key (the settings.json field name among them). */
  aliases: readonly string[]
  description: string
  /** The accepted values, or `model` for a provider/model id checked against settings. */
  values: (ctx: ConfigContext) => readonly string[] | 'model'
  /** The value in effect now. */
  current: (settings: AppSettings, live: ConfigLive) => string
}

const ON_OFF = ['on', 'off'] as const
const onOff = (b: boolean): string => (b ? 'on' : 'off')

export const CONFIG_KEYS: readonly ConfigKeySpec[] = [
  {
    key: 'theme',
    aliases: ['tuiTheme', 'tui-theme'],
    description: 'terminal color theme',
    values: (ctx) => ctx.themes,
    current: (_s, live) => live.theme
  },
  {
    key: 'vim',
    aliases: ['tuiEditor', 'editor'],
    description: 'vim keys in the composer',
    values: () => ON_OFF,
    current: (s) => onOff(s.tuiEditor === 'vim')
  },
  {
    key: 'verbose',
    aliases: ['tuiVerbose'],
    description: "show each tool's full output as it runs",
    values: () => ON_OFF,
    current: (_s, live) => onOff(live.verbose)
  },
  {
    key: 'thoughts',
    aliases: ['reasoningDisplay', 'reasoning-display'],
    description: 'how reasoning shows as it streams',
    values: () => ['show', 'summary', 'hide'],
    current: (_s, live) => live.reasoningDisplay
  },
  {
    key: 'notify',
    aliases: ['tuiNotify'],
    description: 'bell and terminal notification when a run needs you',
    values: () => NOTIFY_MODES,
    current: (_s, live) => live.notifyMode
  },
  {
    key: 'reduce-motion',
    aliases: ['reduceMotion'],
    description: 'a still activity line instead of the spinner',
    values: () => ON_OFF,
    current: (_s, live) => onOff(live.reduceMotion)
  },
  {
    key: 'screen-reader',
    aliases: ['tuiScreenReader'],
    description: 'plain lines and numbered choices for screen readers',
    values: () => ON_OFF,
    current: (_s, live) => onOff(live.screenReader)
  },
  {
    key: 'model',
    aliases: ['default-model', 'selected'],
    description: 'the model new chats start on (/model changes this chat)',
    values: () => 'model',
    current: (s) => (s.selected ? `${s.selected.providerId}/${s.selected.model}` : 'none')
  },
  {
    key: 'effort',
    aliases: ['reasoningEffort', 'reasoning', 'default-effort'],
    description: 'the thinking effort new chats start with (/reasoning changes this chat)',
    values: () => REASONING_EFFORTS,
    current: (s) => s.reasoningEffort ?? DEFAULT_REASONING_EFFORT
  },
  {
    key: 'approval',
    aliases: ['approvalPolicy', 'default-approval'],
    description: 'the approval mode new chats start in (/approval changes this chat)',
    values: () => APPROVAL_POLICIES,
    current: (s) => s.approvalPolicy ?? 'ask'
  },
  {
    key: 'desktop-notifications',
    aliases: ['desktopNotifications'],
    description: "the desktop app's notifications (the terminal follows it while notify is unset)",
    values: () => ON_OFF,
    current: (s) => onOff(s.desktopNotifications !== false)
  },
  {
    key: 'background-wake',
    aliases: ['backgroundWake'],
    description: 'wake an idle chat when background work it started finishes',
    values: () => ON_OFF,
    current: (s) => onOff(s.backgroundWake !== false)
  },
  {
    key: 'memory',
    aliases: ['memoryEnabled'],
    description: 'saved memories ride along with each message',
    values: () => ON_OFF,
    current: (s) => onOff(s.memoryEnabled !== false)
  },
  {
    key: 'usage-limit-wait',
    aliases: ['usageLimitWait'],
    description: 'at a usage limit with a reset time, wait for the reset and continue the turn',
    values: () => ON_OFF,
    current: (s) => onOff(s.usageLimitWait !== false)
  }
]

/** The key spec for a name or alias (case-insensitive), or null. */
export function findConfigKey(name: string): ConfigKeySpec | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return CONFIG_KEYS.find((k) => k.key === n || k.aliases.some((a) => a.toLowerCase() === n)) ?? null
}

const TRUE_WORDS = new Set(['on', 'true', 'yes', '1', 'enable', 'enabled'])
const FALSE_WORDS = new Set(['off', 'false', 'no', '0', 'disable', 'disabled'])

/**
 * The canonical form of `raw` for a key, or an error saying what it accepts. A
 * model is checked against the configured providers and saved as `provider/model`.
 */
export function normalizeConfigValue(
  spec: ConfigKeySpec,
  raw: string,
  ctx: ConfigContext
): { value: string } | { error: string } {
  const v = raw.trim()
  const values = spec.values(ctx)
  if (values === 'model') {
    const resolved = v ? resolveModelArg(v, ctx.settings) : null
    if (!resolved) return { error: `no configured model "${stripControlChars(v)}": use provider/model, a provider id, or a model id from /model` }
    return { value: `${resolved.providerId}/${resolved.model}` }
  }
  const lower = v.toLowerCase()
  if (values === ON_OFF) {
    if (TRUE_WORDS.has(lower)) return { value: 'on' }
    if (FALSE_WORDS.has(lower)) return { value: 'off' }
  } else if (spec.key === 'approval') {
    const policy = parseApprovalPolicy(lower)
    if (policy) return { value: policy }
  } else if ((values as readonly string[]).includes(lower)) {
    return { value: lower }
  }
  return { error: `${spec.key} can't be "${stripControlChars(v)}": use ${values.join(' | ')}` }
}

/** What the user asked `/config` to do. */
export type ConfigOp =
  | { op: 'picker' }
  | { op: 'help' }
  | { op: 'show'; key: ConfigKeyName }
  | { op: 'set'; key: ConfigKeyName; value: string }
  | { op: 'error'; message: string }

/**
 * Parse what follows `/config`: nothing (the picker), `--help`, `key` (show it),
 * or `key=value` / `key value` (set it, validated).
 */
export function parseConfigArgs(arg: string, ctx: ConfigContext): ConfigOp {
  const a = arg.trim()
  if (!a) return { op: 'picker' }
  if (/^(?:--help|-h|help|\?)$/i.test(a)) return { op: 'help' }
  const eq = a.indexOf('=')
  const m = eq >= 0 ? [a.slice(0, eq), a.slice(eq + 1)] : (/^(\S+)(?:\s+([\s\S]*))?$/.exec(a)?.slice(1) ?? [a])
  const name = (m[0] ?? '').trim()
  const raw = m[1]
  const spec = findConfigKey(name)
  if (!spec) {
    return { op: 'error', message: `no setting "${stripControlChars(name)}" here: /config --help lists them` }
  }
  if (raw === undefined) return { op: 'show', key: spec.key }
  if (!raw.trim()) return { op: 'error', message: `give ${spec.key} a value: /config ${spec.key}=<value>` }
  const norm = normalizeConfigValue(spec, raw, ctx)
  return 'error' in norm ? { op: 'error', message: norm.error } : { op: 'set', key: spec.key, value: norm.value }
}

/** The value Enter cycles to in the picker; null for a key that is picked from a list (model). */
export function nextConfigValue(spec: ConfigKeySpec, current: string, ctx: ConfigContext): string | null {
  const values = spec.values(ctx)
  if (values === 'model') return null
  const i = values.indexOf(current)
  return values[(i + 1) % values.length]
}

/**
 * The settings patch and confirmation for a key the driver saves directly (the
 * defaults for new chats and the preferences with no live session state). Null for
 * the terminal keys, which run through their own command's handler.
 */
export function configPatch(
  key: ConfigKeyName,
  value: string,
  settings: AppSettings
): { patch: Partial<AppSettings>; note: string } | null {
  switch (key) {
    case 'model': {
      const resolved = resolveModelArg(value, settings)
      if (!resolved) return null
      return {
        patch: { selected: resolved },
        note: `default model → ${stripControlChars(`${resolved.providerId}/${resolved.model}`)} (new chats and the next launch; /model changes this chat)`
      }
    }
    case 'effort':
      if (!isReasoningEffort(value)) return null
      return {
        patch: { reasoningEffort: value as ReasoningEffort },
        note: `default thinking effort → ${value} (new chats; /reasoning changes this chat)`
      }
    case 'approval': {
      const policy: ApprovalPolicy | null = parseApprovalPolicy(value)
      if (!policy) return null
      return { patch: { approvalPolicy: policy }, note: `default approval → ${policy} (new chats; /approval changes this chat)` }
    }
    case 'desktop-notifications':
      return {
        patch: { desktopNotifications: value === 'on' },
        note: `desktop notifications ${value}`
      }
    case 'background-wake':
      return {
        patch: { backgroundWake: value === 'on' },
        note:
          value === 'on'
            ? 'background wake on: an idle chat picks up when its background work finishes'
            : 'background wake off: finished background work waits for your next message'
      }
    case 'memory':
      return {
        patch: { memoryEnabled: value === 'on' },
        note:
          value === 'on'
            ? 'memory on: the agent sees and saves memories from your next message'
            : 'memory off: the agent runs without memories from your next message (nothing is deleted)'
      }
    case 'usage-limit-wait':
      return {
        patch: { usageLimitWait: value === 'on' },
        note:
          value === 'on'
            ? 'usage limit wait on: a turn stopped at a usage limit waits for the reset, then continues'
            : 'usage limit wait off: a turn stopped at a usage limit fails with the limit\'s error'
      }
    default:
      return null
  }
}

/** `/config key`: the key, its value, what it does and what it accepts. */
export function renderConfigValue(spec: ConfigKeySpec, settings: AppSettings, live: ConfigLive, ctx: ConfigContext): string {
  const values = spec.values(ctx)
  const accepts = values === 'model' ? 'provider/model, a provider id, or a model id' : values.join(' | ')
  return [
    `${spec.key}: ${stripControlChars(spec.current(settings, live))}`,
    `  ${spec.description}`,
    `  values: ${accepts}   (/config ${spec.key}=<value>)`
  ].join('\n')
}

/** `/config --help`: every key with its value now and what it accepts. */
export function renderConfigHelp(settings: AppSettings, live: ConfigLive, ctx: ConfigContext): string {
  const width = Math.max(...CONFIG_KEYS.map((k) => k.key.length)) + 2
  const rows = CONFIG_KEYS.map((k) => {
    const values = k.values(ctx)
    const accepts = values === 'model' ? 'provider/model' : values.join(' | ')
    return `  ${k.key.padEnd(width)}${stripControlChars(k.current(settings, live))}  (${accepts}): ${k.description}`
  })
  return [
    'Settings (/config):',
    ...rows,
    '',
    '  /config                 pick a setting; Enter changes it',
    '  /config <key>           show one',
    '  /config <key>=<value>   set one (saved for every terminal session)',
    '  API keys stay with /login; the desktop app has every other setting.'
  ].join('\n')
}
