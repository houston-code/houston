import { useState } from 'react'
import type { AppSettings, ModelOption, ProviderConfig } from '@shared/types'
import { DEFAULT_COMPACTION_THRESHOLD } from '@shared/defaults'

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
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [newLabel, setNewLabel] = useState('')
  const [newUrl, setNewUrl] = useState('')

  const patchProvider = (id: string, patch: Partial<ProviderConfig>): void => {
    setSettings((s) => ({
      ...s,
      providers: s.providers.map((p) => (p.id === id ? { ...p, ...patch } : p))
    }))
  }

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
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <h2>Settings</h2>
          <button className="modal__close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="modal__body">
          <h3>Providers &amp; models</h3>
          {settings.providers.map((p) => (
            <div className="provider" key={p.id}>
              <div className="provider__head">
                <strong>{p.label}</strong>
                <span className="provider__kind">{p.kind}</span>
                {p.hasKey && <span className="provider__key-ok">key set ✓</span>}
                {!p.builtIn && (
                  <button className="btn btn--danger btn--sm" onClick={() => removeProvider(p.id)}>
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
                    placeholder={p.hasKey ? '•••••••• (stored)' : p.requiresKey ? 'Required' : 'Optional'}
                    value={keyInputs[p.id] ?? ''}
                    onChange={(e) => setKeyInputs((k) => ({ ...k, [p.id]: e.target.value }))}
                  />
                  <button className="btn btn--sm" disabled={busy === p.id} onClick={() => saveKey(p.id)}>
                    Save
                  </button>
                  {p.hasKey && (
                    <button className="btn btn--sm btn--danger" disabled={busy === p.id} onClick={() => removeKey(p.id)}>
                      Remove
                    </button>
                  )}
                </div>
              </label>

              <label className="field">
                <span>
                  Models <button className="link" onClick={() => fetchModels(p.id)} disabled={busy === p.id}>fetch from provider</button>
                </span>
                <textarea
                  rows={3}
                  value={modelsToText(p.models)}
                  placeholder="one model id per line"
                  onChange={(e) => patchProvider(p.id, { models: textToModels(e.target.value, p.models) })}
                />
              </label>
            </div>
          ))}

          <h3>Add a local / custom endpoint</h3>
          <div className="add-endpoint">
            <input placeholder="Label (e.g. My vLLM)" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} />
            <input placeholder="Base URL (http://localhost:8000/v1)" value={newUrl} onChange={(e) => setNewUrl(e.target.value)} />
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
            onChange={(e) => setSettings((s) => ({ ...s, systemPromptExtra: e.target.value }))}
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
