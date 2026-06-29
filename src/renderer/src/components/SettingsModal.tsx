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
import { LICENSE_URL, PRIVACY_URL, TERMS_URL } from '@shared/legal'
import type { UpdateCheckResult } from '@shared/update'
import type {
  AppSettings,
  Hook,
  IntegrationsInfo,
  McpServerConfig,
  ModelOption,
  PermissionRule,
  ProviderConfig
} from '@shared/types'
import { parseHeaderLines, sanitizeServerId } from '@shared/mcp'
import { DEFAULT_COMPACTION_THRESHOLD, DEFAULT_SHELL_OUTPUT_MAX_BYTES } from '@shared/defaults'
import {
  SEARCH_PROVIDERS,
  DEFAULT_SEARCH_PROVIDER_ID,
  getSearchProviderInfo
} from '@shared/search'
import {
  catalogForPlatform,
  catalogEntryToProvider,
  type CatalogEntry
} from '@shared/provider-catalog'

/** Settings groups shown as tabs in the left-hand nav. */
type TabId = 'models' | 'tools' | 'workspace' | 'keyboard' | 'appearance'

const TABS: { id: TabId; label: string }[] = [
  { id: 'models', label: 'Models & Inference' },
  { id: 'tools', label: 'Tools & Permissions' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'keyboard', label: 'Keyboard' },
  { id: 'appearance', label: 'Appearance' }
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
  onSaved
}: {
  initial: AppSettings
  onClose: () => void
  onSaved: (s: AppSettings) => void
}): JSX.Element {
  const [settings, setSettings] = useState<AppSettings>(initial)
  const [tab, setTab] = useState<TabId>('models')
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [newLabel, setNewLabel] = useState('')
  const [newUrl, setNewUrl] = useState('')
  const modalRef = useRef<HTMLDivElement>(null)
  useFocusTrap(modalRef, onClose)

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
  const addRule = (): void =>
    setRules([...rules, { action: 'allow', tool: 'run_shell', match: '' }])
  const patchRule = (i: number, patch: Partial<PermissionRule>): void =>
    setRules(rules.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  const removeRule = (i: number): void => setRules(rules.filter((_, idx) => idx !== i))

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

  const servers = settings.mcpServers ?? []
  const setServers = (next: McpServerConfig[]): void =>
    setSettings((s) => ({ ...s, mcpServers: next }))
  const addServer = (): void =>
    setServers([...servers, { id: '', command: '', args: [], enabled: true }])
  const patchServer = (i: number, patch: Partial<McpServerConfig>): void =>
    setServers(servers.map((sv, idx) => (idx === i ? { ...sv, ...patch } : sv)))
  const removeServer = (i: number): void => setServers(servers.filter((_, idx) => idx !== i))

  // Persist the current (non-secret) edits, then run a key/model action that returns fresh settings.
  const persistThen = async (action: () => Promise<AppSettings>): Promise<void> => {
    await window.api.saveSettings(settings)
    const fresh = await action()
    setSettings(fresh)
  }

  const saveKey = async (id: string): Promise<void> => {
    const key = keyInputs[id]?.trim()
    if (!key) return
    setBusy(id)
    try {
      await persistThen(() => window.api.setKey(id, key))
      setKeyInputs((k) => ({ ...k, [id]: '' }))
    } catch (e) {
      // Surface storage failures (e.g. OS Keychain unavailable) instead of
      // letting the key silently vanish.
      alert(`Could not save API key: ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  const removeKey = async (id: string): Promise<void> => {
    setBusy(id)
    try {
      await persistThen(() => window.api.deleteKey(id))
    } finally {
      setBusy(null)
    }
  }

  const fetchModels = async (id: string): Promise<void> => {
    setBusy(id)
    try {
      await window.api.saveSettings(settings)
      const fetched = await window.api.listModels(id)
      // Adopt fetched ids + capability metadata, but keep any curated label the
      // user already had for that id (the listing rarely carries display labels).
      const prev = new Map(
        (settings.providers.find((p) => p.id === id)?.models ?? []).map((m) => [m.id, m])
      )
      patchProvider(id, { models: fetched.map((m) => ({ ...m, label: m.label ?? prev.get(m.id)?.label })) })
    } catch (e) {
      alert(`Could not fetch models: ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  const addEndpoint = (): void => {
    const label = newLabel.trim()
    const baseUrl = newUrl.trim()
    if (!label || !baseUrl) return
    const id = `custom-${crypto.randomUUID().slice(0, 8)}`
    setSettings((s) => ({
      ...s,
      providers: [
        ...s.providers,
        {
          id,
          kind: 'openai-compatible',
          label,
          baseUrl,
          models: [],
          requiresKey: false,
          hasKey: false,
          builtIn: false
        }
      ]
    }))
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
    <div className="modal-backdrop" onClick={onClose}>
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
          <button className="modal__close" onClick={onClose} aria-label="Close settings">
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
                            <textarea
                              rows={2}
                              placeholder="one per line (e.g. HTTP-Referer: https://myapp)"
                              value={Object.entries(p.headers ?? {})
                                .map(([k, v]) => `${k}: ${v}`)
                                .join('\n')}
                              onChange={(e) =>
                                patchProvider(p.id, { headers: parseHeaderLines(e.target.value) })
                              }
                            />
                          </label>
                        </>
                      )}

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

                      <label className="field">
                        <span>
                          Models{' '}
                          <button
                            className="link"
                            onClick={() => fetchModels(p.id)}
                            disabled={busy === p.id}
                          >
                            fetch from provider
                          </button>
                        </span>
                        <textarea
                          rows={3}
                          value={modelsToText(p.models)}
                          placeholder="one model id per line"
                          onChange={(e) =>
                            patchProvider(p.id, { models: textToModels(e.target.value, p.models) })
                          }
                        />
                      </label>
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
                      Compact the conversation when it grows past this many tokens (0 to disable).
                      Lower it for small-context local models.
                    </span>
                    <input
                      type="number"
                      min={0}
                      step={1000}
                      value={settings.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD}
                      onChange={(e) =>
                        setSettings((s) => ({
                          ...s,
                          compactionThreshold: Math.max(0, Math.floor(Number(e.target.value) || 0))
                        }))
                      }
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
                      command, path, URL, or query.
                    </>
                  }
                >
                  <datalist id="tool-names">
                    {TOOL_NAMES.map((t) => (
                      <option key={t} value={t} />
                    ))}
                  </datalist>
                  {rules.map((r, i) => (
                    <div className="rule" key={i}>
                      <select
                        value={r.action}
                        onChange={(e) =>
                          patchRule(i, { action: e.target.value as PermissionRule['action'] })
                        }
                      >
                        <option value="allow">Allow</option>
                        <option value="ask">Ask</option>
                        <option value="deny">Deny</option>
                      </select>
                      <input
                        list="tool-names"
                        className="rule__tool"
                        placeholder="tool (or *)"
                        value={r.tool}
                        onChange={(e) => patchRule(i, { tool: e.target.value.trim() })}
                      />
                      <input
                        className="rule__match"
                        placeholder="pattern, e.g. git * or src/**"
                        value={r.match}
                        onChange={(e) => patchRule(i, { match: e.target.value })}
                      />
                      <button className="btn btn--sm btn--danger" onClick={() => removeRule(i)}>
                        ✕
                      </button>
                    </div>
                  ))}
                  <button className="btn btn--sm" onClick={addRule}>
                    + Add rule
                  </button>
                </SettingsSection>

                <SettingsSection
                  title="Hooks"
                  desc={
                    <>
                      Shell commands run around tool calls (sandboxed to the project, no network).{' '}
                      <strong>PreToolUse</strong> runs before a tool — a non-zero exit blocks it;{' '}
                      <strong>PostToolUse</strong> runs after, and its output is shown to the agent
                      (e.g. a formatter or test run). The call&apos;s context is in{' '}
                      <code>$HOUSTON_TOOL_NAME</code> / <code>$HOUSTON_TOOL_INPUT</code>.
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
                      or a remote <strong>HTTP</strong> or <strong>SSE</strong> endpoint (optionally
                      authenticated with a bearer-token header). Their tools are offered to the agent
                      as <code>mcp__&lt;id&gt;__&lt;tool&gt;</code> and always require approval. stdio
                      commands run as you (not sandboxed), so only add servers you trust.
                    </>
                  }
                >
                  {servers.map((sv, i) => {
                    const transport = sv.transport ?? (sv.url && !sv.command ? 'http' : 'stdio')
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
                            <textarea
                              className="mcp-server__args"
                              placeholder="headers, one per line (e.g. Authorization: Bearer TOKEN)"
                              rows={2}
                              value={Object.entries(sv.headers ?? {})
                                .map(([k, v]) => `${k}: ${v}`)
                                .join('\n')}
                              onChange={(e) =>
                                patchServer(i, { headers: parseHeaderLines(e.target.value) })
                              }
                            />
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

                <SettingsSection
                  title="Legal"
                  desc="The terms you accepted when you started using Houston."
                >
                  <p className="settings-legal__links">
                    <a href={TERMS_URL} target="_blank" rel="noreferrer">
                      Terms of Use
                    </a>
                    {' · '}
                    <a href={PRIVACY_URL} target="_blank" rel="noreferrer">
                      Privacy Policy
                    </a>
                    {' · '}
                    <a href={LICENSE_URL} target="_blank" rel="noreferrer">
                      License
                    </a>
                  </p>
                </SettingsSection>
              </>
            )}
          </div>
        </div>

        <div className="modal__foot">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--accent" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
