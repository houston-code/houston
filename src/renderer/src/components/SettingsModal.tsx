import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useFocusTrap } from '../lib/useFocusTrap'
import { useApplyTheme } from '../hooks/useApplyTheme'
import { applyTheme } from '../lib/theme'
import {
  SHORTCUTS,
  isCustomizable,
  isMacPlatform,
  formatChord,
  type ShortcutDef
} from '../lib/shortcuts'
import { chordFromString, chordFromEvent, chordToString } from '../lib/keybindingOverrides'
import { LICENSE_URL, PRIVACY_URL } from '@shared/legal'
import type { UpdateCheckResult } from '@shared/update'
import type {
  AppSettings,
  Hook,
  IntegrationsInfo,
  McpServerConfig,
  McpServerStatus,
  ModelOption,
  PermissionRule,
  ProviderConfig
} from '@shared/types'
import { removeFolderTrust } from '@shared/types'
import type { SandboxEgressSettings } from '@shared/egress'
import { parseHeaderLines, sanitizeServerId } from '@shared/mcp'
import { DEFAULT_SHELL_OUTPUT_MAX_BYTES, DEFAULT_MAX_ITERATIONS } from '@shared/defaults'
import {
  SEARCH_PROVIDERS,
  DEFAULT_SEARCH_PROVIDER_ID,
  getSearchProviderInfo
} from '@shared/search'
import {
  catalogForPlatform,
  catalogEntryToProvider,
  customEndpointToProvider,
  customProviderId,
  DEFAULT_AZURE_API_VERSION,
  type CatalogEntry
} from '@shared/provider-catalog'

/** Settings groups shown as tabs in the left-hand nav. */
type TabId = 'models' | 'tools' | 'workspace' | 'keyboard' | 'appearance' | 'legal'

const TABS: { id: TabId; label: string }[] = [
  { id: 'models', label: 'Models & Inference' },
  { id: 'tools', label: 'Tools & Permissions' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'keyboard', label: 'Keyboard' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'legal', label: 'Legal' }
]

/** Tool names offered as autocomplete in the permission-rule editor. */
const TOOL_NAMES = [
  '*',
  'read_file',
  'write_file',
  'edit_file',
  'list_dir',
  'glob',
  'search_files',
  'run_shell',
  'web_fetch',
  'web_search'
]

/** A permission rule kept alongside its real index in `settings.permissionRules`. */
interface IndexedRule {
  rule: PermissionRule
  index: number
}
interface RuleSubgroup {
  label: string
  rules: IndexedRule[]
}
interface RuleGroup {
  tool: string
  count: number
  subgroups: RuleSubgroup[]
}

/** Whether a rule matches the free-text filter (tool, pattern, or action substring). */
function ruleMatchesFilter(rule: PermissionRule, filter: string): boolean {
  const q = filter.trim().toLowerCase()
  if (!q) return true
  return (
    rule.tool.toLowerCase().includes(q) ||
    (rule.match ?? '').toLowerCase().includes(q) ||
    rule.action.includes(q)
  )
}

/** The first repo-ish absolute/home path a run_shell pattern targets, or null. */
function shellRuleRoot(match: string): string | null {
  const m = /(?:^|[\s"'([{])((?:\/|~\/)[^\s"'|&;)}\]]+)/.exec(match)
  return m ? m[1] : null
}

/** Order tools by their position in TOOL_NAMES, then unknown tools alphabetically. */
function toolOrder(tool: string): number {
  const i = TOOL_NAMES.indexOf(tool)
  return i === -1 ? TOOL_NAMES.length : i
}

/**
 * Group permission rules by tool (each keeps its real array index for editing) after
 * applying the filter. The run_shell group is further split by the repo path a rule's
 * pattern targets, so a pile of legacy `cd /repo && …` rules clusters per repo; a group
 * with a single bucket renders flat.
 */
function groupPermissionRules(rules: PermissionRule[], filter: string): RuleGroup[] {
  const byTool = new Map<string, IndexedRule[]>()
  rules.forEach((rule, index) => {
    if (!ruleMatchesFilter(rule, filter)) return
    const tool = rule.tool || '*'
    const list = byTool.get(tool) ?? []
    list.push({ rule, index })
    byTool.set(tool, list)
  })
  const groups: RuleGroup[] = []
  for (const [tool, list] of byTool) {
    let subgroups: RuleSubgroup[] = [{ label: '', rules: list }]
    if (tool === 'run_shell') {
      const bySub = new Map<string, IndexedRule[]>()
      for (const ir of list) {
        const label = shellRuleRoot(ir.rule.match ?? '') ?? 'Commands'
        const arr = bySub.get(label) ?? []
        arr.push(ir)
        bySub.set(label, arr)
      }
      if (bySub.size > 1) subgroups = [...bySub.entries()].map(([label, r]) => ({ label, rules: r }))
    }
    groups.push({ tool, count: list.length, subgroups })
  }
  return groups.sort((a, b) => toolOrder(a.tool) - toolOrder(b.tool) || a.tool.localeCompare(b.tool))
}

function modelsToText(models: ModelOption[]): string {
  return models.map((m) => m.id).join('\n')
}

function textToModels(text: string, prev: ModelOption[]): ModelOption[] {
  const labelById = new Map(prev.map((m) => [m.id, m.label]))
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((id) => ({ id, label: labelById.get(id) }))
}

/**
 * "One model id per line" editor. Holds raw text in local state while the field
 * is focused so Enter, spaces, and blank lines behave normally, and only
 * normalizes (trim + drop empty lines) on blur. A controlled textarea that
 * re-parsed on every keystroke would strip the trailing newline as it was typed,
 * making it impossible to open a new line for the next id.
 */
function ModelsField({
  models,
  busy,
  onFetch,
  onChange
}: {
  models: ModelOption[]
  busy: boolean
  onFetch: () => void
  onChange: (models: ModelOption[]) => void
}): JSX.Element {
  const [text, setText] = useState(() => modelsToText(models))
  // Re-sync from props when the list changes externally (e.g. "fetch from
  // provider"), but never while focused — that would clobber an in-progress edit.
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setText(modelsToText(models))
  }, [models])

  return (
    <label className="field">
      <span>
        Models{' '}
        <button className="link" onClick={onFetch} disabled={busy}>
          fetch from provider
        </button>
      </span>
      <textarea
        rows={3}
        value={text}
        placeholder="one model id per line"
        onFocus={() => {
          focused.current = true
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          focused.current = false
          const normalized = textToModels(text, models)
          onChange(normalized)
          setText(modelsToText(normalized))
        }}
      />
    </label>
  )
}

function headersToText(headers: Record<string, string> | undefined): string {
  return Object.entries(headers ?? {})
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
}

/**
 * "One `Key: Value` per line" header editor. Like ModelsField, it holds raw text
 * in local state while focused and only parses on blur. Parsing every keystroke
 * would drop a line the instant you typed its key (before the colon) and strip
 * trailing newlines — making it impossible to start a new header line.
 */
function HeadersField({
  headers,
  onChange,
  className,
  rows = 2,
  placeholder
}: {
  headers: Record<string, string> | undefined
  onChange: (headers: Record<string, string>) => void
  className?: string
  rows?: number
  placeholder?: string
}): JSX.Element {
  const [text, setText] = useState(() => headersToText(headers))
  // Re-sync when the value changes from outside, but never while focused.
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setText(headersToText(headers))
  }, [headers])

  return (
    <textarea
      className={className}
      rows={rows}
      placeholder={placeholder}
      value={text}
      onFocus={() => {
        focused.current = true
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        focused.current = false
        const parsed = parseHeaderLines(text)
        onChange(parsed)
        setText(headersToText(parsed))
      }}
    />
  )
}

/**
 * "One domain per line" editor for the sandbox-egress allow/deny lists. Same
 * local-text-while-focused pattern as ModelsField: parsing on every keystroke
 * would strip the newline being typed. Entries are free-form here — the egress
 * matcher (@shared/egress parseEgressEntry) tolerates pasted URLs, `*.` prefixes,
 * and ports, so the editor only trims and drops blank lines.
 */
function DomainListField({
  label,
  domains,
  placeholder,
  onChange
}: {
  label: string
  domains: string[]
  placeholder: string
  onChange: (domains: string[]) => void
}): JSX.Element {
  const [text, setText] = useState(() => domains.join('\n'))
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setText(domains.join('\n'))
  }, [domains])

  return (
    <label className="field">
      <span>{label}</span>
      <textarea
        rows={3}
        value={text}
        placeholder={placeholder}
        onFocus={() => {
          focused.current = true
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          focused.current = false
          const parsed = text
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
          onChange(parsed)
          setText(parsed.join('\n'))
        }}
      />
    </label>
  )
}

/**
 * One settings subsection: a restyled <h3> title (kept as a real heading with
 * its exact text — tests query it), an optional one-line description, and a
 * body. Flat by design — separation comes from a top hairline + rhythm, not a
 * box. Purely presentational; adds no class any test depends on.
 */
function SettingsSection({
  title,
  desc,
  children
}: {
  title: string
  desc?: ReactNode
  children: ReactNode
}): JSX.Element {
  return (
    <section className="set-section">
      <div className="set-section__head">
        <h3>{title}</h3>
      </div>
      {desc != null && <p className="set-section__desc">{desc}</p>}
      <div className="set-section__body">{children}</div>
    </section>
  )
}

/**
 * Decorative monoline glyph per nav tab. Rendered inside an aria-hidden span so
 * it never alters the button's accessible name (which must stay exactly the tab
 * label). currentColor lets each icon track the idle/hover/active text colour.
 */
const NAV_ICON: Record<TabId, JSX.Element> = {
  legal: (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 1.5h4.5L12 5v9a1 1 0 01-1 1H4a1 1 0 01-1-1V2.5a1 1 0 011-1z" />
      <path d="M8.5 1.5V5H12M5.5 8h5M5.5 10.5h5M5.5 5.5h1.5" />
    </svg>
  ),
  models: (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="4" width="8" height="8" rx="1" />
      <path d="M6.5 1.5v2M9.5 1.5v2M6.5 12.5v2M9.5 12.5v2M1.5 6.5h2M1.5 9.5h2M12.5 6.5h2M12.5 9.5h2" />
    </svg>
  ),
  tools: (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 1.5l5 2v3.6c0 3-2.1 5.2-5 6.4-2.9-1.2-5-3.4-5-6.4V3.5l5-2z" />
    </svg>
  ),
  workspace: (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1.5 4.5a1 1 0 011-1h3l1.5 1.5h5a1 1 0 011 1v6a1 1 0 01-1 1h-10a1 1 0 01-1-1z" />
    </svg>
  ),
  keyboard: (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.5" y="4" width="13" height="8" rx="1.5" />
      <path d="M4 6.5h0M6.5 6.5h0M9 6.5h0M11.5 6.5h0M4 9h0M11.5 9h0M6 9h4" />
    </svg>
  ),
  appearance: (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15M3.05 3.05l1.15 1.15M11.8 11.8l1.15 1.15M12.95 3.05l-1.15 1.15M4.2 11.8l-1.15 1.15" />
    </svg>
  )
}

/** One customizable shortcut: shows its binding and records a replacement on demand. */
function KeybindRow({
  def,
  binding,
  overridden,
  mac,
  onSet,
  onReset
}: {
  def: ShortcutDef
  binding: string | null
  overridden: boolean
  mac: boolean
  onSet: (value: string | null) => void
  onReset: () => void
}): JSX.Element {
  const [recording, setRecording] = useState(false)

  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent): void => {
      // Capture the keystroke for this row only — keep it from triggering app
      // shortcuts or the dialog's focus trap while recording.
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setRecording(false)
        return
      }
      const chord = chordFromEvent(e)
      if (!chord) return // ignore bare modifier presses; wait for a real key
      onSet(chordToString(chord))
      setRecording(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, onSet])

  const chord = binding ? chordFromString(binding) : null
  const label = recording ? 'Press keys…' : chord ? formatChord(chord, mac) : 'Unbound'

  return (
    <div className="keybind-row">
      <span className="keybind-row__label">{def.label}</span>
      <div className="keybind-row__controls">
        <button
          className={`kbd keybind-row__capture${recording ? ' is-recording' : ''}`}
          onClick={() => setRecording((r) => !r)}
          title={recording ? 'Press a shortcut, or Esc to cancel' : 'Click to record a new shortcut'}
        >
          {label}
        </button>
        {binding && !recording && (
          <button className="btn btn--sm" onClick={() => onSet(null)} title="Disable this shortcut">
            Disable
          </button>
        )}
        {overridden && (
          <button className="btn btn--sm" onClick={onReset} title="Restore the default">
            Reset
          </button>
        )}
      </div>
    </div>
  )
}

/** The Keyboard settings tab: the list of rebindable shortcuts. Exported for tests. */
export function KeyboardTab({
  overrides,
  onSet,
  onReset,
  onResetAll
}: {
  overrides: Record<string, string | null> | undefined
  onSet: (id: string, value: string | null) => void
  onReset: (id: string) => void
  onResetAll: () => void
}): JSX.Element {
  const mac = useMemo(() => isMacPlatform(), [])
  const rows = useMemo(() => SHORTCUTS.filter(isCustomizable), [])
  const hasOverrides = !!overrides && Object.keys(overrides).length > 0

  return (
    <SettingsSection
      title="Keyboard shortcuts"
      desc={
        <>
          Click a binding to record a new key combination, or disable it. Press{' '}
          {mac ? '⌘/' : 'Ctrl+/'} (or ?) anytime to see the full list.
        </>
      }
    >
      <div className="keybind-list">
        {rows.map((def) => {
          const overridden = !!overrides && def.id in overrides
          const binding = overridden ? overrides[def.id] : chordToString(def.chords[0])
          return (
            <KeybindRow
              key={def.id}
              def={def}
              binding={binding}
              overridden={overridden}
              mac={mac}
              onSet={(v) => onSet(def.id, v)}
              onReset={() => onReset(def.id)}
            />
          )
        })}
      </div>
      {hasOverrides && (
        <button className="btn btn--sm" onClick={onResetAll}>
          Reset all to defaults
        </button>
      )}
    </SettingsSection>
  )
}

export function SettingsModal({
  initial,
  onClose,
  onSaved,
  onShowScorecard
}: {
  initial: AppSettings
  onClose: () => void
  onSaved: (s: AppSettings) => void
  /** Open the local-only per-model loop scorecard (from the Models tab). */
  onShowScorecard?: () => void
}): JSX.Element {
  const [settings, setSettings] = useState<AppSettings>(initial)
  const [tab, setTab] = useState<TabId>('models')
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [newLabel, setNewLabel] = useState('')
  const [newUrl, setNewUrl] = useState('')
  // A key/model action error, shown inline in the footer (vs a blocking alert()).
  const [formError, setFormError] = useState<string | null>(null)
  // True once a close is requested while there are unsaved edits — the footer then
  // asks to confirm rather than discarding silently.
  const [confirmingClose, setConfirmingClose] = useState(false)
  const modalRef = useRef<HTMLDivElement>(null)

  // A stable digest of the persisted-settings baseline (derived key flags stripped,
  // since those change via the key actions, not "unsaved edits"). Updated whenever
  // the working settings are persisted, so the dirty check reflects real edits.
  const digest = (s: AppSettings): string =>
    JSON.stringify({
      ...s,
      providers: s.providers.map((p) => ({ ...p, hasKey: false })),
      searchKeyStatus: undefined
    })
  const savedDigest = useRef(digest(initial))
  const isDirty = digest(settings) !== savedDigest.current

  // Guard close (X / backdrop / Esc): warn once when there are unsaved edits.
  const requestClose = (): void => {
    if (isDirty) setConfirmingClose(true)
    else onClose()
  }
  useFocusTrap(modalRef, requestClose)

  // Live-preview the selected color theme while the modal is open, so the user
  // sees the change before committing. If they close without saving we revert to
  // whatever theme was active when the modal opened. `committed` guards the
  // revert: once Save persists the selection it becomes the real theme, so the
  // unmount cleanup must leave it in place. This is purely CSS-variable driven
  // (data-theme on <html>), so the preview behaves identically on macOS, Linux,
  // and Windows.
  useApplyTheme(settings.theme ?? 'system')
  const themeAtOpen = useRef<AppSettings['theme']>(initial.theme ?? 'system').current
  const committed = useRef(false)
  useEffect(
    () => () => {
      if (!committed.current) applyTheme(themeAtOpen ?? 'system')
    },
    [themeAtOpen]
  )

  // Known-host catalog for the "Add a provider" picker. Platform-filtered (e.g. the
  // Apple-Silicon oMLX preset is hidden off macOS); hosts already present are shown
  // disabled so they can't be added twice.
  const catalog = useMemo(() => catalogForPlatform(isMacPlatform()), [])
  const existingProviderIds = useMemo(
    () => new Set(settings.providers.map((p) => p.id)),
    [settings.providers]
  )

  // ---- Keyboard-shortcut overrides (Keyboard tab) ----
  const setKeybind = (id: string, value: string | null): void =>
    setSettings((s) => ({ ...s, keybindings: { ...(s.keybindings ?? {}), [id]: value } }))
  const resetKeybind = (id: string): void =>
    setSettings((s) => {
      const next = { ...(s.keybindings ?? {}) }
      delete next[id]
      return { ...s, keybindings: next }
    })
  const resetAllKeybinds = (): void => setSettings((s) => ({ ...s, keybindings: {} }))

  // Updates section: current version + manual "Check for updates".
  const [version, setVersion] = useState('')
  const [checking, setChecking] = useState(false)
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null)
  useEffect(() => {
    void window.api.getVersion().then(setVersion)
  }, [])

  // Optional-integrations status (gh CLI + formatters), shown as a hint in the Tools tab.
  const [integrations, setIntegrations] = useState<IntegrationsInfo | null>(null)
  useEffect(() => {
    void window.api.getIntegrations().then(setIntegrations)
  }, [])
  // Permission-rule editor view state: filter text, in-flight "Clean up rules",
  // the tool for a newly-added rule, and which tool groups the user has collapsed.
  const [ruleFilter, setRuleFilter] = useState('')
  const [cleaningRules, setCleaningRules] = useState(false)
  const [newRuleTool, setNewRuleTool] = useState('')
  const [collapsedRuleGroups, setCollapsedRuleGroups] = useState<Set<string>>(new Set())
  const toggleRuleGroup = (tool: string, open: boolean): void =>
    setCollapsedRuleGroups((prev) => {
      const next = new Set(prev)
      if (open) next.delete(tool)
      else next.add(tool)
      return next
    })
  const checkForUpdates = async (): Promise<void> => {
    setChecking(true)
    setUpdateResult(null)
    try {
      setUpdateResult(await window.api.checkForUpdates())
    } finally {
      setChecking(false)
    }
  }

  const patchProvider = (id: string, patch: Partial<ProviderConfig>): void => {
    setSettings((s) => ({
      ...s,
      providers: s.providers.map((p) => (p.id === id ? { ...p, ...patch } : p))
    }))
  }

  const rules = settings.permissionRules ?? []
  const setRules = (next: PermissionRule[]): void =>
    setSettings((s) => ({ ...s, permissionRules: next }))
  // Default to 'ask', not 'allow': an all-approving rule shouldn't be one careless
  // click + Save away (the empty match pattern would otherwise auto-approve every
  // run_shell call). New rules are added for a specific tool (the group they land in).
  const addRuleFor = (tool: string): void =>
    setRules([...rules, { action: 'ask', tool, match: '' }])
  const patchRule = (i: number, patch: Partial<PermissionRule>): void =>
    setRules(rules.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  const removeRule = (i: number): void => setRules(rules.filter((_, idx) => idx !== i))
  // "Clean up rules": re-generalize + dedupe via the shared main-process helper.
  const cleanupRules = async (): Promise<void> => {
    setCleaningRules(true)
    try {
      setRules(await window.api.cleanupPermissionRules(rules))
    } finally {
      setCleaningRules(false)
    }
  }
  // Group rules by tool (keeping each rule's real index for patch/remove), honouring
  // the filter, then sub-group run_shell by the repo path its pattern targets (if any).
  const ruleGroups = groupPermissionRules(rules, ruleFilter)

  const hooks = settings.hooks ?? []
  const setHooks = (next: Hook[]): void => setSettings((s) => ({ ...s, hooks: next }))
  const addHook = (): void =>
    setHooks([...hooks, { event: 'PostToolUse', matcher: 'edit_file', command: '' }])
  const patchHook = (i: number, patch: Partial<Hook>): void =>
    setHooks(hooks.map((h, idx) => (idx === i ? { ...h, ...patch } : h)))
  const removeHook = (i: number): void => setHooks(hooks.filter((_, idx) => idx !== i))

  const additionalRoots = settings.additionalRoots ?? []
  const addRoot = async (): Promise<void> => {
    const dir = await window.api.pickDirectory()
    if (dir && !additionalRoots.includes(dir)) {
      setSettings((s) => ({ ...s, additionalRoots: [...(s.additionalRoots ?? []), dir] }))
    }
  }
  const removeRoot = (dir: string): void =>
    setSettings((s) => ({
      ...s,
      additionalRoots: (s.additionalRoots ?? []).filter((d) => d !== dir)
    }))

  // Sandbox egress: absent settings mean allowlist mode (the secure default).
  const egress = settings.sandboxEgress ?? {}
  const egressMode: 'allowlist' | 'all' = egress.mode === 'all' ? 'all' : 'allowlist'
  const patchEgress = (patch: Partial<SandboxEgressSettings>): void =>
    setSettings((s) => ({ ...s, sandboxEgress: { ...(s.sandboxEgress ?? {}), ...patch } }))

  const servers = settings.mcpServers ?? []
  const setServers = (next: McpServerConfig[]): void =>
    setSettings((s) => ({ ...s, mcpServers: next }))
  const addServer = (): void =>
    setServers([...servers, { id: '', command: '', args: [], enabled: true }])
  const patchServer = (i: number, patch: Partial<McpServerConfig>): void =>
    setServers(servers.map((sv, idx) => (idx === i ? { ...sv, ...patch } : sv)))
  const removeServer = (i: number): void => setServers(servers.filter((_, idx) => idx !== i))

  // Live per-server connection badges (connected / needs sign-in / error), read
  // once per modal open — the manager updates them on each run's reconcile.
  const [mcpStatuses, setMcpStatuses] = useState<McpServerStatus[]>([])
  useEffect(() => {
    let alive = true
    void window.api
      .getMcpStatuses()
      .then((s) => {
        if (alive) setMcpStatuses(s)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  // Merge the fresh derived hasOAuth flags into the working copy, preserving
  // every pending edit (same contract as applyKeyResult for provider keys).
  const applyOAuthFlags = (fresh: AppSettings): void =>
    setSettings((s) => ({
      ...s,
      mcpServers: s.mcpServers?.map((sv) => ({
        ...sv,
        hasOAuth: fresh.mcpServers?.find((x) => x.id === sv.id)?.hasOAuth ?? false
      }))
    }))

  // OAuth sign-in for a remote server. The flow reads the *persisted* server URL
  // by id, so the working edits are saved first (same pattern as fetchModels).
  const mcpSignIn = async (id: string): Promise<void> => {
    if (!id) return
    setBusy(`mcp-oauth:${id}`)
    setFormError(null)
    try {
      await window.api.saveSettings(settings)
      committed.current = true
      savedDigest.current = digest(settings)
      const res = await window.api.mcpOAuthLogin(id)
      if (!res.ok) setFormError(`MCP sign-in failed: ${res.error ?? 'unknown error'}`)
      applyOAuthFlags(res.settings)
    } catch (e) {
      setFormError(`MCP sign-in failed: ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  const mcpSignOut = async (id: string): Promise<void> => {
    setBusy(`mcp-oauth:${id}`)
    setFormError(null)
    try {
      applyOAuthFlags(await window.api.mcpOAuthLogout(id))
    } catch (e) {
      setFormError(`Could not sign out: ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  // An API key lives in the OS secret store, not settings.json — so saving/removing
  // one is its own action and must NOT persist the modal's other (unsaved) edits.
  // We merge just the derived key flags from main's response into the working copy,
  // keeping every pending edit intact so Cancel still discards them.
  const applyKeyResult = (fresh: AppSettings, id: string, has: boolean): void =>
    setSettings((s) => ({
      ...s,
      providers: s.providers.map((p) => {
        const fp = fresh.providers.find((x) => x.id === p.id)
        // The just-(un)keyed provider is definitive; others take main's recomputed
        // flag (a new unsaved provider isn't in `fresh`, so fall back to `has`).
        return { ...p, hasKey: p.id === id ? has : (fp?.hasKey ?? p.hasKey) }
      }),
      searchKeyStatus: fresh.searchKeyStatus
    }))

  const saveKey = async (id: string): Promise<void> => {
    const key = keyInputs[id]?.trim()
    if (!key) return
    setBusy(id)
    setFormError(null)
    try {
      applyKeyResult(await window.api.setKey(id, key), id, true)
      setKeyInputs((k) => ({ ...k, [id]: '' }))
    } catch (e) {
      // Surface storage failures (e.g. OS Keychain unavailable) instead of
      // letting the key silently vanish.
      setFormError(`Could not save API key: ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  const removeKey = async (id: string): Promise<void> => {
    setBusy(id)
    setFormError(null)
    try {
      applyKeyResult(await window.api.deleteKey(id), id, false)
    } catch (e) {
      setFormError(`Could not remove API key: ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  const fetchModels = async (id: string): Promise<void> => {
    setBusy(id)
    setFormError(null)
    try {
      // listModels reads the provider's config from the persisted settings, so the
      // working edits must be saved first. That commits them — including the
      // previewed theme — so lock in the theme too and refresh the dirty baseline.
      await window.api.saveSettings(settings)
      committed.current = true
      savedDigest.current = digest(settings)
      const fetched = await window.api.listModels(id)
      // Adopt fetched ids + capability metadata, but keep any curated label the
      // user already had for that id (the listing rarely carries display labels).
      const prev = new Map(
        (settings.providers.find((p) => p.id === id)?.models ?? []).map((m) => [m.id, m])
      )
      patchProvider(id, { models: fetched.map((m) => ({ ...m, label: m.label ?? prev.get(m.id)?.label })) })
    } catch (e) {
      setFormError(`Could not fetch models: ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  const addEndpoint = (): void => {
    const label = newLabel.trim()
    const baseUrl = newUrl.trim()
    if (!label || !baseUrl) return
    const provider = customEndpointToProvider(customProviderId(crypto.randomUUID()), label, baseUrl)
    setSettings((s) => ({ ...s, providers: [...s.providers, provider] }))
    setNewLabel('')
    setNewUrl('')
  }

  // Add a known host from the catalog. Idempotent: the catalog reuses a stable id,
  // so an already-added host is a no-op (and is shown disabled in the picker).
  const addCatalogProvider = (entry: CatalogEntry): void => {
    setSettings((s) =>
      s.providers.some((p) => p.id === entry.id)
        ? s
        : { ...s, providers: [...s.providers, catalogEntryToProvider(entry)] }
    )
  }

  const removeProvider = (id: string): void => {
    setSettings((s) => ({ ...s, providers: s.providers.filter((p) => p.id !== id) }))
  }

  const save = async (): Promise<void> => {
    const fresh = await window.api.saveSettings(settings)
    // Lock in the previewed theme: skip the revert-on-unmount below.
    committed.current = true
    savedDigest.current = digest(settings)
    onSaved(fresh)
    onClose()
  }

  // Tone for the optional-integration status pills. While still loading we use a
  // neutral accent pill so "Checking…" doesn't masquerade as an amber warning.
  const ghTone =
    integrations == null
      ? 'accent'
      : integrations.gh.installed && integrations.gh.authenticated
        ? 'ok'
        : 'warn'
  const formatterTone =
    integrations != null && integrations.formatters.some((f) => f.installed) ? 'ok' : 'warn'

  return (
    <div className="modal-backdrop" onClick={requestClose}>
      <div
        className="modal"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal__head">
          <h2 id="settings-title">Settings</h2>
          <button className="modal__close" onClick={requestClose} aria-label="Close settings">
            ✕
          </button>
        </div>

        <div className="modal__main">
          <nav className="modal__nav">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={t.id === tab ? 'is-active' : ''}
                onClick={() => setTab(t.id)}
              >
                <span className="set-nav__icon" aria-hidden="true">
                  {NAV_ICON[t.id]}
                </span>
                {t.label}
              </button>
            ))}
          </nav>

          <div className="modal__body">
            {tab === 'models' && (
              <>
                <SettingsSection title="Providers &amp; models">
                  {settings.providers.map((p) => (
                    <div className="provider" key={p.id}>
                      <div className="provider__head">
                        <strong>{p.label}</strong>
                        <span className="provider__kind">{p.kind}</span>
                        {p.hasKey && (
                          <span className="provider__key-ok pill pill--ok">key set ✓</span>
                        )}
                        {!p.builtIn && (
                          <button
                            className="btn btn--danger btn--sm"
                            onClick={() => removeProvider(p.id)}
                          >
                            Remove
                          </button>
                        )}
                      </div>

                      {(p.kind === 'openai-compatible' || p.baseUrl !== undefined) && (
                        <>
                          <label className="field">
                            <span>Base URL</span>
                            <input
                              value={p.baseUrl ?? ''}
                              placeholder="https://host/v1"
                              onChange={(e) => patchProvider(p.id, { baseUrl: e.target.value })}
                            />
                          </label>

                          <label className="field">
                            <span>Custom headers</span>
                            <HeadersField
                              headers={p.headers}
                              placeholder="one per line (e.g. HTTP-Referer: https://myapp)"
                              onChange={(headers) => patchProvider(p.id, { headers })}
                            />
                          </label>
                        </>
                      )}

                      {(p.kind === 'bedrock' || p.kind === 'vertex') && (
                        <>
                          <label className="field">
                            <span>Region</span>
                            <input
                              value={p.region ?? ''}
                              placeholder={p.kind === 'bedrock' ? 'us-east-1' : 'us-east5'}
                              onChange={(e) => patchProvider(p.id, { region: e.target.value })}
                            />
                          </label>

                          {p.kind === 'vertex' && (
                            <label className="field">
                              <span>Project ID</span>
                              <input
                                value={p.projectId ?? ''}
                                placeholder="Optional, inferred from your credentials"
                                onChange={(e) =>
                                  patchProvider(p.id, { projectId: e.target.value })
                                }
                              />
                            </label>
                          )}

                          <p className="field__hint">
                            {p.kind === 'bedrock' ? (
                              <>
                                Signs requests with your AWS credentials: a{' '}
                                <code>~/.aws/credentials</code> profile, SSO, or an IAM role. A
                                Bedrock API key below is optional and takes precedence over them.
                              </>
                            ) : (
                              <>
                                Authenticates with your Google Cloud credentials. Run{' '}
                                <code>gcloud auth application-default login</code> if you have not
                                already.
                              </>
                            )}
                          </p>
                        </>
                      )}

                      {p.kind === 'azure-openai' && (
                        <>
                          <label className="field">
                            <span>Endpoint</span>
                            <input
                              value={p.endpoint ?? ''}
                              placeholder="https://my-resource.openai.azure.com"
                              onChange={(e) => patchProvider(p.id, { endpoint: e.target.value })}
                            />
                          </label>

                          <label className="field">
                            <span>API version</span>
                            <input
                              value={p.apiVersion ?? ''}
                              placeholder={DEFAULT_AZURE_API_VERSION}
                              onChange={(e) => patchProvider(p.id, { apiVersion: e.target.value })}
                            />
                          </label>

                          <p className="field__hint">
                            Each model above is the name of a deployment on your resource, so add
                            the names you created in the Azure portal. A newer model may need a
                            newer API version.
                          </p>
                        </>
                      )}

                      {p.kind === 'foundry' && (
                        <>
                          <label className="field">
                            <span>Resource</span>
                            <input
                              value={p.resource ?? ''}
                              placeholder="my-resource"
                              onChange={(e) => patchProvider(p.id, { resource: e.target.value })}
                            />
                          </label>

                          <p className="field__hint">
                            The resource name from your Foundry endpoint, the{' '}
                            <code>my-resource</code> in{' '}
                            <code>https://my-resource.services.ai.azure.com</code>.
                          </p>
                        </>
                      )}

                      {/*
                        Vertex takes no API key at all (its SDK omits the option and
                        uses Google ADC), so offering the field would only invite a key
                        that is silently ignored.
                      */}
                      {p.kind !== 'vertex' && (
                        <label className="field">
                          <span>API key</span>
                          <div className="field__row">
                            <input
                              type="password"
                              placeholder={
                                p.hasKey
                                  ? '•••••••• (stored)'
                                  : p.requiresKey
                                    ? 'Required'
                                    : 'Optional'
                              }
                              value={keyInputs[p.id] ?? ''}
                              onChange={(e) =>
                                setKeyInputs((k) => ({ ...k, [p.id]: e.target.value }))
                              }
                            />
                            <button
                              className="btn btn--sm"
                              disabled={busy === p.id}
                              onClick={() => saveKey(p.id)}
                            >
                              Save
                            </button>
                            {p.hasKey && (
                              <button
                                className="btn btn--sm btn--danger"
                                disabled={busy === p.id}
                                onClick={() => removeKey(p.id)}
                              >
                                Remove
                              </button>
                            )}
                          </div>
                        </label>
                      )}

                      <ModelsField
                        models={p.models}
                        busy={busy === p.id}
                        onFetch={() => fetchModels(p.id)}
                        onChange={(models) => patchProvider(p.id, { models })}
                      />
                    </div>
                  ))}
                </SettingsSection>

                <SettingsSection
                  title="Add a provider"
                  desc="Pick a known host, or point Houston at any OpenAI-compatible server — local or hosted."
                >
                  <label className="field">
                    <span>Known hosts</span>
                    <select
                      value=""
                      onChange={(e) => {
                        const entry = catalog.find((c) => c.id === e.target.value)
                        if (entry) addCatalogProvider(entry)
                        e.currentTarget.selectedIndex = 0
                      }}
                    >
                      <option value="">Choose a host to add…</option>
                      <optgroup label="Cloud (API key)">
                        {catalog
                          .filter((c) => c.category === 'cloud')
                          .map((c) => (
                            <option
                              key={c.id}
                              value={c.id}
                              title={c.blurb}
                              disabled={existingProviderIds.has(c.id)}
                            >
                              {c.label}
                              {existingProviderIds.has(c.id) ? ' — added' : ''}
                            </option>
                          ))}
                      </optgroup>
                      <optgroup label="Local / self-hosted">
                        {catalog
                          .filter((c) => c.category === 'local')
                          .map((c) => (
                            <option
                              key={c.id}
                              value={c.id}
                              title={c.blurb}
                              disabled={existingProviderIds.has(c.id)}
                            >
                              {c.label}
                              {existingProviderIds.has(c.id) ? ' — added' : ''}
                            </option>
                          ))}
                      </optgroup>
                    </select>
                  </label>

                  <div className="add-endpoint">
                    <input
                      placeholder="Custom label (e.g. My vLLM)"
                      value={newLabel}
                      onChange={(e) => setNewLabel(e.target.value)}
                    />
                    <input
                      placeholder="Base URL (http://localhost:8000/v1)"
                      value={newUrl}
                      onChange={(e) => setNewUrl(e.target.value)}
                    />
                    <button className="btn" onClick={addEndpoint}>
                      Add custom
                    </button>
                  </div>
                </SettingsSection>

                <SettingsSection
                  title="System prompt addition"
                  desc="Extra instructions appended to every conversation in this workspace."
                >
                  <textarea
                    className="full-textarea"
                    rows={3}
                    placeholder="Extra instructions appended to every conversation (optional)."
                    value={settings.systemPromptExtra ?? ''}
                    onChange={(e) =>
                      setSettings((s) => ({ ...s, systemPromptExtra: e.target.value }))
                    }
                  />
                </SettingsSection>

                <SettingsSection
                  title="Context window"
                  desc="Cap conversation size and per-command output so a long session or a runaway command can't flood the model's context."
                >
                  <label className="field">
                    <span>
                      Compact the conversation when it grows past this many tokens. Leave empty
                      for automatic sizing from the selected model&apos;s context window; set 0 to
                      disable compaction.
                    </span>
                    <input
                      type="number"
                      min={0}
                      step={1000}
                      placeholder="Automatic"
                      value={settings.compactionThreshold ?? ''}
                      onChange={(e) => {
                        const raw = e.target.value
                        setSettings((s) => {
                          // Empty input = automatic: store no override at all rather than a number.
                          if (raw.trim() === '') {
                            const { compactionThreshold: _threshold, ...rest } = s
                            return rest
                          }
                          return {
                            ...s,
                            compactionThreshold: Math.max(0, Math.floor(Number(raw) || 0))
                          }
                        })
                      }}
                    />
                  </label>
                  <label className="field">
                    <span>
                      Truncate a single command&apos;s output to this many bytes, keeping both ends
                      (~4 bytes ≈ 1 token). Stops one runaway command from flooding the context
                      window.
                    </span>
                    <input
                      type="number"
                      min={1000}
                      step={1000}
                      value={settings.shellOutputMaxBytes ?? DEFAULT_SHELL_OUTPUT_MAX_BYTES}
                      onChange={(e) =>
                        setSettings((s) => ({
                          ...s,
                          shellOutputMaxBytes: Math.max(
                            1000,
                            Math.floor(Number(e.target.value) || 0)
                          )
                        }))
                      }
                    />
                  </label>
                </SettingsSection>

                <SettingsSection
                  title="Loop control"
                  desc="Guardrails for long agent turns: cap the work, nudge the model to land cleanly before the cap, catch unproductive loops, and optionally verify changes before the turn ends."
                >
                  <label className="field">
                    <span>
                      Stop a single turn after this many steps (tool calls + replies). As the run
                      nears this cap it&apos;s reminded to finish or summarize, so it lands cleanly
                      instead of being cut off mid-edit.
                    </span>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={settings.maxIterations ?? DEFAULT_MAX_ITERATIONS}
                      onChange={(e) =>
                        setSettings((s) => ({
                          ...s,
                          maxIterations: Math.max(1, Math.floor(Number(e.target.value) || 0))
                        }))
                      }
                    />
                  </label>
                  <label className="field">
                    <span>
                      Also remind the model to wrap up once a turn&apos;s cumulative cost crosses this
                      many US dollars (0 to disable the cost-based reminder).
                    </span>
                    <input
                      type="number"
                      min={0}
                      step={0.5}
                      value={settings.costCeilingUsd ?? 0}
                      onChange={(e) =>
                        setSettings((s) => ({
                          ...s,
                          costCeilingUsd: Math.max(0, Number(e.target.value) || 0)
                        }))
                      }
                    />
                  </label>
                  <label className="field field--checkbox">
                    <input
                      type="checkbox"
                      checked={settings.stallDetection !== false}
                      onChange={(e) =>
                        setSettings((s) => ({ ...s, stallDetection: e.target.checked }))
                      }
                    />
                    <span>
                      Detect unproductive loops — repeating the same tool call, hitting the same error
                      over and over, or going several turns without changing any file. On detection
                      the model gets one corrective reminder; if it keeps looping, the turn stops. On
                      by default.
                    </span>
                  </label>
                  <label className="field field--checkbox">
                    <input
                      type="checkbox"
                      checked={settings.verifyOnStop ?? false}
                      onChange={(e) =>
                        setSettings((s) => ({ ...s, verifyOnStop: e.target.checked }))
                      }
                    />
                    <span>
                      When the model finishes after changing files, run the verification command below.
                      If it fails, the output is fed back so the model can self-correct for a bounded
                      number of passes. Off by default, and inert unless you set a command.
                    </span>
                  </label>
                  <label className="field">
                    <span>
                      Verification command (e.g. <code>npm run typecheck</code> or <code>npm test</code>
                      ). Runs in the project folder through the same sandbox as shell commands. Leave
                      empty to disable — nothing runs unless you set this.
                    </span>
                    <input
                      type="text"
                      placeholder="npm run typecheck"
                      value={settings.verifyCommand ?? ''}
                      onChange={(e) =>
                        setSettings((s) => ({ ...s, verifyCommand: e.target.value }))
                      }
                    />
                  </label>
                </SettingsSection>

                <SettingsSection
                  title="Reasoning"
                  desc={
                    <>
                      Reasoning effort is set per-chat in the control bar. These tune how the
                      model&apos;s reasoning is reported and how long replies run (OpenAI Responses
                      models).
                    </>
                  }
                >
                  <label className="field">
                    <span>Reasoning summary</span>
                    <select
                      value={settings.reasoningSummary ?? 'auto'}
                      onChange={(e) =>
                        setSettings((s) => ({
                          ...s,
                          reasoningSummary: e.target.value as AppSettings['reasoningSummary']
                        }))
                      }
                    >
                      <option value="auto">Auto</option>
                      <option value="concise">Concise</option>
                      <option value="detailed">Detailed</option>
                      <option value="none">None</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>Verbosity</span>
                    <select
                      value={settings.verbosity ?? 'medium'}
                      onChange={(e) =>
                        setSettings((s) => ({
                          ...s,
                          verbosity: e.target.value as AppSettings['verbosity']
                        }))
                      }
                    >
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                    </select>
                  </label>
                </SettingsSection>

                <SettingsSection
                  title="Web search"
                  desc={
                    <>
                      Enable the <code>web_search</code> tool by choosing a provider and supplying
                      its API key, stored in your OS keychain.
                    </>
                  }
                >
                  {(() => {
                    // The selected provider drives the whole section: which key field
                    // to show, its placeholder/help link, and whether a key is stored
                    // (read from the per-provider status map, so switching the dropdown
                    // reflects the right provider without a round-trip).
                    const selected = getSearchProviderInfo(
                      settings.searchProvider ?? DEFAULT_SEARCH_PROVIDER_ID
                    )
                    const keySet = settings.searchKeyStatus?.[selected.id] ?? false
                    return (
                      <>
                        <label className="field">
                          <span>Provider</span>
                          <select
                            value={selected.id}
                            onChange={(e) =>
                              setSettings((s) => ({ ...s, searchProvider: e.target.value }))
                            }
                          >
                            {SEARCH_PROVIDERS.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="field">
                          <span>
                            {selected.label} API key{' '}
                            {keySet && (
                              <span className="provider__key-ok pill pill--ok">key set ✓</span>
                            )}
                          </span>
                          <div className="field__row">
                            <input
                              type="password"
                              placeholder={keySet ? '•••••••• (stored)' : selected.keyPlaceholder}
                              value={keyInputs[selected.keyId] ?? ''}
                              onChange={(e) =>
                                setKeyInputs((k) => ({ ...k, [selected.keyId]: e.target.value }))
                              }
                            />
                            <button
                              className="btn btn--sm"
                              disabled={busy === selected.keyId}
                              onClick={() => saveKey(selected.keyId)}
                            >
                              Save
                            </button>
                            {keySet && (
                              <button
                                className="btn btn--sm btn--danger"
                                disabled={busy === selected.keyId}
                                onClick={() => removeKey(selected.keyId)}
                              >
                                Remove
                              </button>
                            )}
                          </div>
                          <p className="set-section__desc">Get a key at {selected.keyUrl}</p>
                        </label>
                      </>
                    )
                  })()}
                </SettingsSection>

                {onShowScorecard && (
                  <SettingsSection
                    title="Loop scorecard"
                    desc="See how each model has actually behaved across your chats — average steps, tool use, clean-finish rate, and cost. Aggregated on-device from your local data only, never sent anywhere."
                  >
                    <button type="button" className="btn" onClick={onShowScorecard}>
                      Open loop scorecard
                    </button>
                  </SettingsSection>
                )}
              </>
            )}

            {tab === 'tools' && (
              <>
                <SettingsSection
                  title="Permissions"
                  desc={
                    <>
                      Rules are checked before the approval policy (first match wins).{' '}
                      <strong>Allow</strong> auto-approves, <strong>Deny</strong> refuses,{' '}
                      <strong>Ask</strong> always prompts. The pattern is a glob over the call&apos;s
                      command, path, URL, or query. These are your global rules; a project&apos;s{' '}
                      <code>.houston/settings.json</code> may add stricter deny/ask rules that apply
                      first and aren&apos;t shown here.
                    </>
                  }
                >
                  <datalist id="tool-names">
                    {TOOL_NAMES.map((t) => (
                      <option key={t} value={t} />
                    ))}
                  </datalist>

                  {rules.length > 0 && (
                    <div className="rule-toolbar">
                      <input
                        className="rule-filter"
                        placeholder="Filter rules…"
                        value={ruleFilter}
                        onChange={(e) => setRuleFilter(e.target.value)}
                      />
                      <span className="rule-toolbar__count">
                        {rules.length} {rules.length === 1 ? 'rule' : 'rules'}
                      </span>
                      <button
                        className="btn btn--sm"
                        onClick={cleanupRules}
                        disabled={cleaningRules}
                        title="Re-generalize run_shell rules and remove duplicates"
                      >
                        {cleaningRules ? 'Cleaning…' : 'Clean up rules'}
                      </button>
                    </div>
                  )}

                  {rules.length > 0 && ruleGroups.length === 0 && (
                    <p className="rule-empty">No rules match the filter.</p>
                  )}

                  {ruleGroups.map((group) => (
                    <details
                      className="rule-group"
                      key={group.tool}
                      open={!collapsedRuleGroups.has(group.tool)}
                      onToggle={(e) => toggleRuleGroup(group.tool, e.currentTarget.open)}
                    >
                      <summary className="rule-group__head">
                        <span className="rule-group__tool">{group.tool}</span>
                        <span className="rule-group__count">{group.count}</span>
                      </summary>
                      {group.subgroups.map((sub, si) => (
                        <div className="rule-subgroup" key={sub.label || si}>
                          {sub.label && (
                            <div className="rule-subgroup__label" title={sub.label}>
                              {sub.label}
                            </div>
                          )}
                          {sub.rules.map(({ rule, index }) => (
                            <div className="rule" key={index}>
                              <select
                                value={rule.action}
                                onChange={(e) =>
                                  patchRule(index, {
                                    action: e.target.value as PermissionRule['action']
                                  })
                                }
                              >
                                <option value="allow">Allow</option>
                                <option value="ask">Ask</option>
                                <option value="deny">Deny</option>
                              </select>
                              <input
                                className="rule__match"
                                placeholder="pattern, e.g. git * or src/**"
                                value={rule.match}
                                onChange={(e) => patchRule(index, { match: e.target.value })}
                              />
                              <button
                                className="btn btn--sm btn--danger"
                                onClick={() => removeRule(index)}
                              >
                                ✕
                              </button>
                            </div>
                          ))}
                        </div>
                      ))}
                      <button
                        className="btn btn--sm rule-group__add"
                        onClick={() => addRuleFor(group.tool)}
                      >
                        + Add {group.tool} rule
                      </button>
                    </details>
                  ))}

                  <div className="rule-add-other">
                    <input
                      list="tool-names"
                      className="rule__tool"
                      placeholder="tool (or *)"
                      value={newRuleTool}
                      onChange={(e) => setNewRuleTool(e.target.value.trim())}
                    />
                    <button
                      className="btn btn--sm"
                      onClick={() => {
                        addRuleFor(newRuleTool || 'run_shell')
                        setNewRuleTool('')
                      }}
                    >
                      + Add rule
                    </button>
                  </div>
                </SettingsSection>

                <SettingsSection
                  title="Hooks"
                  desc={
                    <>
                      Shell commands run at points in the agent loop (sandboxed to the project, no
                      network). <strong>PreToolUse</strong> runs before a tool — a non-zero exit
                      blocks it; <strong>PostToolUse</strong> runs after, and its output is shown to
                      the agent. <strong>UserPromptSubmit</strong> / <strong>SessionStart</strong> /{' '}
                      <strong>Stop</strong> / <strong>PreCompact</strong> run around the turn (a Stop
                      hook that exits non-zero makes the agent keep working). Context is in{' '}
                      <code>$HOUSTON_TOOL_NAME</code> / <code>$HOUSTON_TOOL_INPUT</code> /{' '}
                      <code>$HOUSTON_USER_PROMPT</code>. A hook can also print a JSON directive (
                      <code>{'{ decision, reason, additionalContext, updatedInput }'}</code>) on
                      stdout to steer the loop.
                    </>
                  }
                >
                  {hooks.map((h, i) => (
                    <div className="rule" key={i}>
                      <select
                        value={h.event}
                        onChange={(e) => patchHook(i, { event: e.target.value as Hook['event'] })}
                      >
                        <option value="PreToolUse">Pre</option>
                        <option value="PostToolUse">Post</option>
                        <option value="UserPromptSubmit">Prompt</option>
                        <option value="SessionStart">Session</option>
                        <option value="Stop">Stop</option>
                        <option value="PreCompact">Compact</option>
                      </select>
                      <input
                        list="tool-names"
                        className="rule__tool"
                        placeholder="tool (or *)"
                        value={h.matcher}
                        onChange={(e) => patchHook(i, { matcher: e.target.value.trim() })}
                      />
                      <input
                        className="rule__match"
                        placeholder="shell command, e.g. npm run format"
                        value={h.command}
                        onChange={(e) => patchHook(i, { command: e.target.value })}
                      />
                      <button className="btn btn--sm btn--danger" onClick={() => removeHook(i)}>
                        ✕
                      </button>
                    </div>
                  ))}
                  <button className="btn btn--sm" onClick={addHook}>
                    + Add hook
                  </button>
                </SettingsSection>

                <SettingsSection
                  title="Optional integrations"
                  desc="These extras are optional — Houston works without them. Status on this machine:"
                >
                  <div className="integration">
                    <span className="integration__name">
                      GitHub CLI (<code>gh</code>)
                    </span>
                    <span
                      className={`integration__status pill integration__status--${ghTone} pill--${ghTone}`}
                    >
                      {integrations == null
                        ? 'Checking…'
                        : !integrations.gh.installed
                          ? 'Not found'
                          : integrations.gh.authenticated
                            ? 'Installed & signed in'
                            : 'Installed — not signed in'}
                    </span>
                  </div>
                  {integrations != null &&
                    !(integrations.gh.installed && integrations.gh.authenticated) && (
                      <p className="field__hint">
                        Enables the <code>gh_*</code> GitHub tools (pull requests, issues, checks).{' '}
                        {!integrations.gh.installed ? (
                          <>
                            Install it from{' '}
                            <a href="https://cli.github.com" target="_blank" rel="noreferrer">
                              cli.github.com
                            </a>{' '}
                            and run <code>gh auth login</code>.
                          </>
                        ) : (
                          <>
                            Run <code>gh auth login</code> to sign in.
                          </>
                        )}
                      </p>
                    )}
                  {integrations != null && (
                    <>
                      <div className="integration">
                        <span className="integration__name">Formatters (format on save)</span>
                        <span
                          className={`integration__status pill integration__status--${formatterTone} pill--${formatterTone}`}
                        >
                          {integrations.formatters.filter((f) => f.installed).length} of{' '}
                          {integrations.formatters.length} found
                        </span>
                      </div>
                      <p className="field__hint">
                        {integrations.formatters.map((f, i) => (
                          <span key={f.bin}>
                            {i > 0 && ', '}
                            <code>{f.bin}</code> {f.installed ? '✓' : '✗'}
                          </span>
                        ))}
                        . Install the ones you want on your <code>PATH</code>; the matching formatter
                        runs only when present.
                      </p>
                    </>
                  )}
                </SettingsSection>

                <SettingsSection title="Format on save">
                  <label className="field field--checkbox">
                    <input
                      type="checkbox"
                      checked={settings.formatOnSave ?? false}
                      onChange={(e) =>
                        setSettings((s) => ({ ...s, formatOnSave: e.target.checked }))
                      }
                    />
                    <span>
                      After the agent writes a file, run the matching formatter on it (Prettier for
                      JS/TS/JSON/CSS/Markdown, <code>gofmt</code>, <code>rustfmt</code>,{' '}
                      <code>ruff</code>/<code>black</code> for Python). Only runs when the formatter
                      is installed (see <em>Optional integrations</em> above); off by default.
                    </span>
                  </label>
                </SettingsSection>

                <SettingsSection title="Diagnostics on save">
                  <label className="field field--checkbox">
                    <input
                      type="checkbox"
                      checked={settings.diagnosticsOnSave ?? false}
                      onChange={(e) =>
                        setSettings((s) => ({ ...s, diagnosticsOnSave: e.target.checked }))
                      }
                    />
                    <span>
                      After the agent writes a file, run a fast checker on it (<code>eslint</code>{' '}
                      for JS/TS, <code>ruff</code>/<code>pyflakes</code> for Python,{' '}
                      <code>gofmt</code> for Go) and show any problems to the agent so it can
                      self-correct in the same turn. Read-only — never edits the file. Only runs when
                      the checker is installed; off by default.
                    </span>
                  </label>
                </SettingsSection>

                <SettingsSection
                  title="MCP servers"
                  desc={
                    <>
                      Connect Model Context Protocol servers — a local <strong>stdio</strong> process
                      or a remote <strong>HTTP</strong> or <strong>SSE</strong> endpoint. Remote
                      servers authenticate with a bearer-token header or with <strong>OAuth</strong>{' '}
                      (Sign in opens your browser; tokens are stored encrypted and refreshed
                      automatically). Their tools are offered to the agent as{' '}
                      <code>mcp__&lt;id&gt;__&lt;tool&gt;</code> and always require approval. stdio
                      commands run as you (not sandboxed), so only add servers you trust.
                    </>
                  }
                >
                  {servers.map((sv, i) => {
                    const transport = sv.transport ?? (sv.url && !sv.command ? 'http' : 'stdio')
                    const status = mcpStatuses.find((x) => x.id === sv.id)
                    return (
                      <div className="mcp-server" key={i}>
                        <div className="mcp-server__row">
                          <input
                            className="rule__tool"
                            placeholder="id"
                            value={sv.id}
                            onChange={(e) =>
                              patchServer(i, { id: sanitizeServerId(e.target.value) })
                            }
                          />
                          <select
                            value={transport}
                            onChange={(e) =>
                              patchServer(i, {
                                transport: e.target.value as McpServerConfig['transport']
                              })
                            }
                          >
                            <option value="stdio">stdio</option>
                            <option value="http">http</option>
                            <option value="sse">sse</option>
                          </select>
                          <label className="mcp-server__enabled" title="Enabled">
                            <input
                              type="checkbox"
                              checked={sv.enabled}
                              onChange={(e) => patchServer(i, { enabled: e.target.checked })}
                            />
                          </label>
                          <button
                            className="btn btn--sm btn--danger"
                            onClick={() => removeServer(i)}
                          >
                            ✕
                          </button>
                        </div>
                        {transport === 'http' || transport === 'sse' ? (
                          <>
                            <input
                              className="mcp-server__args"
                              placeholder="url (e.g. https://example.com/mcp)"
                              value={sv.url ?? ''}
                              onChange={(e) => patchServer(i, { url: e.target.value })}
                            />
                            <HeadersField
                              className="mcp-server__args"
                              placeholder="headers, one per line (e.g. Authorization: Bearer TOKEN); or use OAuth sign-in below"
                              headers={sv.headers}
                              onChange={(headers) => patchServer(i, { headers })}
                            />
                            <div className="mcp-server__row">
                              {sv.hasOAuth ? (
                                <>
                                  <span className="mcp-server__status mcp-server__status--ok">
                                    Signed in with OAuth
                                  </span>
                                  <button
                                    className="btn btn--sm"
                                    disabled={busy !== null}
                                    onClick={() => void mcpSignOut(sv.id)}
                                  >
                                    Sign out
                                  </button>
                                </>
                              ) : (
                                <button
                                  className="btn btn--sm"
                                  disabled={busy !== null || !sv.id || !sv.url}
                                  title="For servers that require OAuth: opens your browser to authorize Houston, then stores the tokens encrypted"
                                  onClick={() => void mcpSignIn(sv.id)}
                                >
                                  {busy === `mcp-oauth:${sv.id}` ? 'Waiting for browser…' : 'Sign in (OAuth)'}
                                </button>
                              )}
                              {status && (
                                <span
                                  className={`mcp-server__status${status.state === 'connected' ? ' mcp-server__status--ok' : status.state === 'needs-auth' ? ' mcp-server__status--warn' : ' mcp-server__status--err'}`}
                                >
                                  {status.state === 'connected'
                                    ? `Connected (${status.tools ?? 0} tool${status.tools === 1 ? '' : 's'})`
                                    : status.state === 'needs-auth'
                                      ? 'Needs sign-in'
                                      : `Connection failed: ${status.error ?? 'unknown error'}`}
                                </span>
                              )}
                            </div>
                          </>
                        ) : (
                          <>
                            <input
                              className="mcp-server__args"
                              placeholder="command (e.g. npx)"
                              value={sv.command}
                              onChange={(e) => patchServer(i, { command: e.target.value })}
                            />
                            <input
                              className="mcp-server__args"
                              placeholder="args (space-separated, e.g. -y @modelcontextprotocol/server-filesystem .)"
                              value={(sv.args ?? []).join(' ')}
                              onChange={(e) =>
                                patchServer(i, {
                                  args: e.target.value.split(/\s+/).filter(Boolean)
                                })
                              }
                            />
                            <input
                              className="mcp-server__args"
                              placeholder="working directory (optional)"
                              value={sv.cwd ?? ''}
                              onChange={(e) => patchServer(i, { cwd: e.target.value || undefined })}
                            />
                            <HeadersField
                              className="mcp-server__args"
                              placeholder="env vars, one per line (e.g. GITHUB_TOKEN: ghp_xxx); values are stored encrypted"
                              headers={sv.env}
                              onChange={(env) => patchServer(i, { env })}
                            />
                            {status && (
                              <span
                                className={`mcp-server__status${status.state === 'connected' ? ' mcp-server__status--ok' : ' mcp-server__status--err'}`}
                              >
                                {status.state === 'connected'
                                  ? `Connected (${status.tools ?? 0} tool${status.tools === 1 ? '' : 's'})`
                                  : `Connection failed: ${status.error ?? 'unknown error'}`}
                              </span>
                            )}
                          </>
                        )}
                      </div>
                    )
                  })}
                  <button className="btn btn--sm" onClick={addServer}>
                    + Add MCP server
                  </button>
                </SettingsSection>
              </>
            )}

            {tab === 'workspace' && (
              <>
                <SettingsSection
                  title="Additional folders"
                  desc={
                    <>
                      Extra directories the agent may read and write, beyond the project folder.
                      They&apos;re added to the file tools&apos; allowed roots and the shell sandbox.
                      Only add folders you trust the agent to modify.
                    </>
                  }
                >
                  {additionalRoots.map((dir) => (
                    <div className="rule" key={dir}>
                      <code className="rule__path" title={dir}>
                        {dir}
                      </code>
                      <button className="btn btn--sm btn--danger" onClick={() => removeRoot(dir)}>
                        ✕
                      </button>
                    </div>
                  ))}
                  <button className="btn btn--sm" onClick={() => void addRoot()}>
                    + Add folder
                  </button>
                </SettingsSection>

                <SettingsSection
                  title="Trusted folders"
                  desc={
                    <>
                      Projects whose <code>.houston/settings.json</code> asks for extra permissions
                      (allow rules, hooks, MCP servers) and how you answered. Forget a decision to
                      be asked again the next time that folder is open; a trusted project is also
                      re-asked automatically whenever its configuration changes.
                    </>
                  }
                >
                  {(settings.trustedFolders ?? []).length === 0 && (
                    <p className="settings-empty">
                      No decisions yet. You&apos;ll be asked when a project requests extra
                      permissions.
                    </p>
                  )}
                  {(settings.trustedFolders ?? []).map((t) => (
                    <div className="rule" key={t.path}>
                      <span
                        className={`mcp-server__status ${t.decision === 'trusted' ? 'mcp-server__status--ok' : 'mcp-server__status--warn'}`}
                      >
                        {t.decision === 'trusted' ? 'trusted' : 'never'}
                      </span>
                      <code className="rule__path" title={t.path}>
                        {t.path}
                      </code>
                      <span className="settings-dim">
                        {new Date(t.decidedAt).toLocaleDateString()}
                      </span>
                      <button
                        className="btn btn--sm btn--danger"
                        title="Forget this decision (asks again on next open)"
                        onClick={() =>
                          setSettings((s) => ({
                            ...s,
                            trustedFolders: removeFolderTrust(s.trustedFolders, t.path)
                          }))
                        }
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </SettingsSection>

                <SettingsSection
                  title="Sandbox egress"
                  desc={
                    <>
                      Where shell commands may connect once network is granted. The allowlist
                      restricts granted network to common development infrastructure (package
                      registries, VCS hosts) plus the domains you add; each entry also covers its
                      subdomains, and the deny list wins over every allow. &quot;All domains&quot;
                      removes the restriction: any granted command can then reach any host.
                    </>
                  }
                >
                  <label className="field">
                    <span>Mode</span>
                    <select
                      value={egressMode}
                      onChange={(e) =>
                        patchEgress({ mode: e.target.value as SandboxEgressSettings['mode'] })
                      }
                    >
                      <option value="allowlist">Allowlist (recommended)</option>
                      <option value="all">All domains</option>
                    </select>
                  </label>
                  {egressMode === 'allowlist' && (
                    <>
                      <DomainListField
                        label="Additional allowed domains"
                        domains={egress.allow ?? []}
                        placeholder={'one domain per line, e.g. artifactory.corp.example'}
                        onChange={(allow) => patchEgress({ allow })}
                      />
                      <DomainListField
                        label="Denied domains"
                        domains={egress.deny ?? []}
                        placeholder={'one domain per line; overrides the allowlist'}
                        onChange={(deny) => patchEgress({ deny })}
                      />
                    </>
                  )}
                </SettingsSection>
              </>
            )}

            {tab === 'keyboard' && (
              <KeyboardTab
                overrides={settings.keybindings}
                onSet={setKeybind}
                onReset={resetKeybind}
                onResetAll={resetAllKeybinds}
              />
            )}

            {tab === 'appearance' && (
              <>
                <SettingsSection
                  title="Appearance"
                  desc="Choose how Houston looks; System follows your OS setting."
                >
                  <label className="field">
                    <span>Color theme</span>
                    <select
                      value={settings.theme ?? 'system'}
                      onChange={(e) =>
                        setSettings((s) => ({ ...s, theme: e.target.value as AppSettings['theme'] }))
                      }
                    >
                      <option value="system">System</option>
                      <option value="dark">Dark</option>
                      <option value="light">Light</option>
                    </select>
                  </label>
                </SettingsSection>

                <SettingsSection title="Notifications">
                  <label className="field field--checkbox">
                    <input
                      type="checkbox"
                      checked={settings.desktopNotifications ?? true}
                      onChange={(e) =>
                        setSettings((s) => ({ ...s, desktopNotifications: e.target.checked }))
                      }
                    />
                    <span>
                      Show a desktop notification when the agent finishes a turn, needs approval,
                      asks a question, or opens/merges a pull request while Houston isn’t the focused
                      window. On by default.
                    </span>
                  </label>
                </SettingsSection>

                <SettingsSection
                  title="Updates"
                  desc="Your installed version, and a manual check for new releases."
                >
                  <div className="updates-row">
                    <span className="updates-row__version">Houston {version || '—'}</span>
                    <button
                      className="btn btn--sm"
                      onClick={() => void checkForUpdates()}
                      disabled={checking}
                    >
                      {checking ? 'Checking…' : 'Check for updates'}
                    </button>
                  </div>
                  {updateResult && (
                    <p className="updates-status">
                      {updateResult.status === 'available' && (
                        <>
                          Houston <strong>{updateResult.latestVersion}</strong> is available.{' '}
                          <a href={updateResult.releaseUrl} target="_blank" rel="noreferrer">
                            Download
                          </a>
                        </>
                      )}
                      {updateResult.status === 'up-to-date' && 'You’re on the latest version.'}
                      {updateResult.status === 'disabled' &&
                        'Update checks run only in packaged builds.'}
                      {updateResult.status === 'error' &&
                        `Couldn’t check for updates: ${updateResult.message}`}
                    </p>
                  )}
                </SettingsSection>
              </>
            )}
            {tab === 'legal' && (
              <>
                <SettingsSection
                  title="Legal"
                  desc="How Houston handles your data, and the open-source license Houston itself ships under."
                >
                  <p className="settings-legal__links">
                    <a href={PRIVACY_URL} target="_blank" rel="noreferrer">
                      Privacy
                    </a>
                    {' · '}
                    <a href={LICENSE_URL} target="_blank" rel="noreferrer">
                      License (Apache-2.0)
                    </a>
                  </p>
                </SettingsSection>
              </>
            )}
          </div>
        </div>

        <div className="modal__foot">
          {formError && (
            <span
              role="alert"
              style={{ marginRight: 'auto', color: 'var(--danger)', fontSize: '12px' }}
            >
              {formError}
            </span>
          )}
          {confirmingClose ? (
            <>
              <span style={{ marginRight: 'auto', color: 'var(--text-dim)', fontSize: '13px' }}>
                Discard unsaved changes?
              </span>
              <button className="btn" onClick={() => setConfirmingClose(false)}>
                Keep editing
              </button>
              <button className="btn btn--danger" onClick={onClose}>
                Discard
              </button>
            </>
          ) : (
            <>
              <button className="btn" onClick={requestClose}>
                Cancel
              </button>
              <button className="btn btn--accent" onClick={save}>
                Save
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
