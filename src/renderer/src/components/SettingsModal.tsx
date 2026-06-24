import { useRef, useState } from 'react'
import { useFocusTrap } from '../lib/useFocusTrap'
import type {
  AppSettings,
  Hook,
  McpServerConfig,
  ModelOption,
  PermissionRule,
  ProviderConfig
} from '@shared/types'
import { parseHeaderLines, sanitizeServerId } from '@shared/mcp'
import { DEFAULT_COMPACTION_THRESHOLD } from '@shared/defaults'
import { WEB_SEARCH_KEY_ID } from '@shared/constants'

/** Settings groups shown as tabs in the left-hand nav. */
type TabId = 'models' | 'tools' | 'workspace' | 'appearance'

const TABS: { id: TabId; label: string }[] = [
  { id: 'models', label: 'Models & Inference' },
  { id: 'tools', label: 'Tools & Permissions' },
  { id: 'workspace', label: 'Workspace' },
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
      const ids = await window.api.listModels(id)
      patchProvider(id, { models: ids.map((m) => ({ id: m })) })
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

  const removeProvider = (id: string): void => {
    setSettings((s) => ({ ...s, providers: s.providers.filter((p) => p.id !== id) }))
  }

  const save = async (): Promise<void> => {
    const fresh = await window.api.saveSettings(settings)
    onSaved(fresh)
    onClose()
  }

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
                {t.label}
              </button>
            ))}
          </nav>

          <div className="modal__body">
            {tab === 'models' && (
              <>
                <h3>Providers &amp; models</h3>
                {settings.providers.map((p) => (
                  <div className="provider" key={p.id}>
                    <div className="provider__head">
                      <strong>{p.label}</strong>
                      <span className="provider__kind">{p.kind}</span>
                      {p.hasKey && <span className="provider__key-ok">key set ✓</span>}
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
                      <label className="field">
                        <span>Base URL</span>
                        <input
                          value={p.baseUrl ?? ''}
                          placeholder="https://host/v1"
                          onChange={(e) => patchProvider(p.id, { baseUrl: e.target.value })}
                        />
                      </label>
                    )}

                    <label className="field">
                      <span>API key</span>
                      <div className="field__row">
                        <input
                          type="password"
                          placeholder={
                            p.hasKey ? '•••••••• (stored)' : p.requiresKey ? 'Required' : 'Optional'
                          }
                          value={keyInputs[p.id] ?? ''}
                          onChange={(e) => setKeyInputs((k) => ({ ...k, [p.id]: e.target.value }))}
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

                <h3>Add a local / custom endpoint</h3>
                <div className="add-endpoint">
                  <input
                    placeholder="Label (e.g. My vLLM)"
                    value={newLabel}
                    onChange={(e) => setNewLabel(e.target.value)}
                  />
                  <input
                    placeholder="Base URL (http://localhost:8000/v1)"
                    value={newUrl}
                    onChange={(e) => setNewUrl(e.target.value)}
                  />
                  <button className="btn" onClick={addEndpoint}>
                    Add
                  </button>
                </div>

                <h3>System prompt addition</h3>
                <textarea
                  className="full-textarea"
                  rows={3}
                  placeholder="Extra instructions appended to every conversation (optional)."
                  value={settings.systemPromptExtra ?? ''}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, systemPromptExtra: e.target.value }))
                  }
                />

                <h3>Context window</h3>
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

                <h3>Web search</h3>
                <label className="field">
                  <span>
                    Tavily API key for the <code>web_search</code> tool{' '}
                    {settings.hasWebSearchKey && (
                      <span className="provider__key-ok">key set ✓</span>
                    )}
                  </span>
                  <div className="field__row">
                    <input
                      type="password"
                      placeholder={settings.hasWebSearchKey ? '•••••••• (stored)' : 'tvly-…'}
                      value={keyInputs[WEB_SEARCH_KEY_ID] ?? ''}
                      onChange={(e) =>
                        setKeyInputs((k) => ({ ...k, [WEB_SEARCH_KEY_ID]: e.target.value }))
                      }
                    />
                    <button
                      className="btn btn--sm"
                      disabled={busy === WEB_SEARCH_KEY_ID}
                      onClick={() => saveKey(WEB_SEARCH_KEY_ID)}
                    >
                      Save
                    </button>
                    {settings.hasWebSearchKey && (
                      <button
                        className="btn btn--sm btn--danger"
                        disabled={busy === WEB_SEARCH_KEY_ID}
                        onClick={() => removeKey(WEB_SEARCH_KEY_ID)}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </label>
              </>
            )}

            {tab === 'tools' && (
              <>
                <h3>Permissions</h3>
                <p className="field__hint">
                  Rules are checked before the approval policy (first match wins).{' '}
                  <strong>Allow</strong> auto-approves, <strong>Deny</strong> refuses,{' '}
                  <strong>Ask</strong> always prompts. The pattern is a glob over the call&apos;s
                  command, path, URL, or query.
                </p>
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

                <h3>Hooks</h3>
                <p className="field__hint">
                  Shell commands run around tool calls (sandboxed to the project, no network).{' '}
                  <strong>PreToolUse</strong> runs before a tool — a non-zero exit blocks it;{' '}
                  <strong>PostToolUse</strong> runs after, and its output is shown to the agent (e.g. a
                  formatter or test run). The call&apos;s context is in{' '}
                  <code>$HOUSTON_TOOL_NAME</code> / <code>$HOUSTON_TOOL_INPUT</code>.
                </p>
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

                <h3>MCP servers</h3>
                <p className="field__hint">
                  Connect Model Context Protocol servers — a local <strong>stdio</strong> process or a
                  remote <strong>HTTP</strong> or <strong>SSE</strong> endpoint (optionally
                  authenticated with a bearer-token header). Their tools are offered to the agent as{' '}
                  <code>mcp__&lt;id&gt;__&lt;tool&gt;</code> and always require approval. stdio
                  commands run as you (not sandboxed), so only add servers you trust.
                </p>
                {servers.map((sv, i) => {
                  const transport = sv.transport ?? (sv.url && !sv.command ? 'http' : 'stdio')
                  return (
                    <div className="mcp-server" key={i}>
                      <div className="mcp-server__row">
                        <input
                          className="rule__tool"
                          placeholder="id"
                          value={sv.id}
                          onChange={(e) => patchServer(i, { id: sanitizeServerId(e.target.value) })}
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
                              patchServer(i, { args: e.target.value.split(/\s+/).filter(Boolean) })
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
              </>
            )}

            {tab === 'workspace' && (
              <>
                <h3>Additional folders</h3>
                <p className="field__hint">
                  Extra directories the agent may read and write, beyond the project folder.
                  They&apos;re added to the file tools&apos; allowed roots and the shell sandbox.
                  Only add folders you trust the agent to modify.
                </p>
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
              </>
            )}

            {tab === 'appearance' && (
              <>
                <h3>Appearance</h3>
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
