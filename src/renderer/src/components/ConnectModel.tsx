import { useState, type KeyboardEvent } from 'react'
import type { AppSettings, ProviderConfig } from '@shared/types'
import { modelDisplayName, pickDefaultModel } from '@shared/models'
import { SecureStorageNotice, secureStorageBlocked } from './SecureStorageNotice'

/**
 * Inline "Connect a model" step of the get-started checklist: pick a provider, paste
 * a key, and have it verified with a live model listing before the step ticks off.
 * A local host (Ollama, LM Studio) needs no key; it's checked by listing its models.
 * Everything else about providers stays in Settings; this covers the first key only.
 *
 * Opened again from a finished step 1 (the checklist's Change button), it starts on
 * what's already set: the selected provider, a "Key saved" line instead of an empty
 * key box (Replace key brings the box back), and a model picker.
 */

/** Where to get a key, per built-in cloud provider. */
const KEY_URL: Record<string, string> = {
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
  gemini: 'https://aistudio.google.com/apikey'
}

/** Short tile names for the built-in providers, in display order. */
const TILE_LABEL: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Gemini',
  ollama: 'Ollama',
  lmstudio: 'LM Studio'
}

/** A provider's short name, as on its tile ("Anthropic"), for summaries like step 1's. */
export function providerShortName(p: Pick<ProviderConfig, 'id' | 'label'>): string {
  return TILE_LABEL[p.id] ?? p.label
}

/** Usable as-is: no key needed or one is stored, and it has models to pick from. */
function isReady(p: ProviderConfig): boolean {
  return (!p.requiresKey || p.hasKey) && p.models.length > 0
}

/** The model to preselect: the current selection on that provider, else its default. */
function initialModel(settings: AppSettings, p: ProviderConfig | undefined): string {
  if (!p) return ''
  if (settings.selected?.providerId === p.id && p.models.some((m) => m.id === settings.selected?.model)) {
    return settings.selected.model
  }
  return pickDefaultModel(p) ?? p.models[0]?.id ?? ''
}

const LOCAL_HINT: Record<string, string> = {
  ollama: 'Start Ollama and pull a model (for example, ollama pull llama3.1), then check again.',
  lmstudio: 'Open LM Studio, load a model, and start its local server, then check again.'
}

/**
 * An error from main arrives wrapped as "Error invoking remote method '<channel>':
 * Error: <message>". Show only the provider's message.
 */
export function ipcErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.replace(/^Error invoking remote method '[^']*':\s*(?:\w*Error:\s*)?/, '')
}

export interface ConnectModelProps {
  settings: AppSettings
  /**
   * Called once a provider is usable, with fresh settings. `model` is set when the user
   * picked one (an already-connected provider); otherwise the app selects the default.
   */
  onConnected: (fresh: AppSettings, providerId: string, model?: string) => void
  onBack: () => void
}

export function ConnectModel({ settings, onConnected, onBack }: ConnectModelProps): JSX.Element {
  const tiles = Object.keys(TILE_LABEL)
    .map((id) => settings.providers.find((p) => p.id === id))
    .filter((p): p is ProviderConfig => !!p)
  // Start on the selected provider, so reopening step 1 shows what's set.
  const [providerId, setProviderId] = useState(
    tiles.some((p) => p.id === settings.selected?.providerId)
      ? (settings.selected?.providerId ?? '')
      : (tiles[0]?.id ?? '')
  )
  // A ready provider shows its saved state and a model picker; "Replace key" (or
  // "Check again" for a local host) switches back to the connect form.
  const [replacing, setReplacing] = useState(false)
  const [model, setModel] = useState(() =>
    initialModel(settings, tiles.find((p) => p.id === providerId))
  )
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A key that failed verification, kept so "Save anyway" can store it (the check
  // can fail for reasons other than a bad key, such as being offline).
  const [unverified, setUnverified] = useState<string | null>(null)
  // The platform, when a save failed because the OS secure store is unusable.
  const [storageBlocked, setStorageBlocked] = useState<string | null>(null)

  const provider = tiles.find((p) => p.id === providerId)
  const local = provider ? !provider.requiresKey : false
  const showReady = provider !== undefined && isReady(provider) && !replacing

  const choose = (id: string): void => {
    setProviderId(id)
    setReplacing(false)
    setModel(initialModel(settings, tiles.find((p) => p.id === id)))
    setError(null)
    setUnverified(null)
    setStorageBlocked(null)
  }

  /** Keep the provider as it is and switch to the picked model. */
  const applyModel = async (): Promise<void> => {
    if (!model) return
    setBusy(true)
    try {
      onConnected(await window.api.getSettings(), providerId, model)
    } catch (e) {
      setError(`Couldn't switch models: ${ipcErrorMessage(e)}`)
    } finally {
      setBusy(false)
    }
  }

  // Radio-group keys: arrows move the selection (and focus) between tiles, wrapping,
  // with Home/End jumping to the ends.
  const onTilesKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const i = tiles.findIndex((t) => t.id === providerId)
    const step: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }
    let next: number
    if (e.key in step) next = (i + step[e.key] + tiles.length) % tiles.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = tiles.length - 1
    else return
    e.preventDefault()
    choose(tiles[next].id)
    e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus()
  }

  /**
   * A key save failed. When the OS secure store is the cause (a denied Keychain prompt),
   * show how to recover, with a restart; otherwise show the error itself.
   */
  const saveFailed = async (e: unknown): Promise<void> => {
    const platform = await secureStorageBlocked()
    if (platform) {
      setUnverified(null)
      setStorageBlocked(platform)
    } else setError(`Couldn't save the key: ${ipcErrorMessage(e)}`)
  }

  /** Store the key, then hand back fresh settings so the app can select a model. */
  const storeKey = async (value: string): Promise<void> => {
    await window.api.setKey(providerId, value)
    setKey('')
    // Replacing the key of a provider that already worked keeps the picked model;
    // a first connection lets the app choose the provider's default.
    const wasReady = provider !== undefined && isReady(provider)
    onConnected(await window.api.getSettings(), providerId, wasReady && model ? model : undefined)
  }

  const connectCloud = async (): Promise<void> => {
    const trimmed = key.trim()
    if (!trimmed) {
      setError('Paste an API key first.')
      return
    }
    setBusy(true)
    setError(null)
    setUnverified(null)
    try {
      // Check the key before storing it, so a typo can't replace a key that works.
      try {
        await window.api.testKey(providerId, trimmed)
      } catch (e) {
        setUnverified(trimmed)
        setError(`That key didn't work: ${ipcErrorMessage(e)}`)
        return
      }
      await storeKey(trimmed)
    } catch (e) {
      await saveFailed(e)
    } finally {
      setBusy(false)
    }
  }

  const connectLocal = async (): Promise<void> => {
    if (!provider) return
    setBusy(true)
    setError(null)
    try {
      const models = await window.api.listModels(providerId).catch(() => [])
      if (models.length === 0) {
        setError(`No models found. ${LOCAL_HINT[providerId] ?? ''}`.trim())
        return
      }
      // Seed the local host's model list so the picker can select one. A list the
      // user curated in Settings is left alone.
      const current = await window.api.getSettings()
      const providers = current.providers.map((p) =>
        p.id === providerId && p.models.length === 0 ? { ...p, models } : p
      )
      onConnected(await window.api.saveSettings({ ...current, providers }), providerId)
    } catch (e) {
      setError(`Couldn't reach ${provider.label}: ${ipcErrorMessage(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const saveAnyway = async (): Promise<void> => {
    if (unverified === null) return
    setBusy(true)
    try {
      await storeKey(unverified)
    } catch (e) {
      await saveFailed(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="onboard-card connect-model" aria-labelledby="connect-model-title">
      <h2 id="connect-model-title" className="onboard-card__title">
        Connect a model
      </h2>
      <p className="onboard-card__sub">
        Houston uses your own provider account, so you pay the provider directly. Local models
        need no key.
      </p>

      <div
        className="connect-model__tiles"
        role="radiogroup"
        aria-label="Provider"
        onKeyDown={onTilesKey}
      >
        {tiles.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={p.id === providerId}
            // One Tab stop for the group (the selected tile); arrows move within it.
            tabIndex={p.id === providerId ? 0 : -1}
            className={`connect-model__tile${p.id === providerId ? ' is-active' : ''}`}
            onClick={() => choose(p.id)}
          >
            {TILE_LABEL[p.id]}
            {isReady(p) && (
              <>
                <span className="connect-model__tile-ok" aria-hidden="true">
                  {' '}✓
                </span>
                <span className="sr-only"> (connected)</span>
              </>
            )}
          </button>
        ))}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          void (showReady ? applyModel() : local ? connectLocal() : connectCloud())
        }}
      >
        {showReady && provider && (
          <>
            <div className="connect-model__saved">
              <span className="connect-model__saved-ok" aria-hidden="true">
                ✓
              </span>
              <span className="connect-model__saved-text">
                {local
                  ? `${providerShortName(provider)} is running with ${provider.models.length} model${provider.models.length === 1 ? '' : 's'}`
                  : `Key saved for ${providerShortName(provider)}`}
              </span>
              <button type="button" className="connect-model__link" onClick={() => setReplacing(true)}>
                {local ? 'Check again' : 'Replace key'}
              </button>
            </div>
            <label className="connect-model__label" htmlFor="connect-model-model">
              Model
            </label>
            <select
              id="connect-model-model"
              className="control control--select connect-model__model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              {provider.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label ?? modelDisplayName(provider.kind, m.id)}
                </option>
              ))}
            </select>
          </>
        )}
        {!showReady && !local && (
          <>
            <label className="connect-model__label" htmlFor="connect-model-key">
              API key
            </label>
            <input
              id="connect-model-key"
              className="control control--input connect-model__key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={key}
              aria-invalid={error !== null}
              aria-describedby={error ? 'connect-model-error' : 'connect-model-note'}
              onChange={(e) => {
                setKey(e.target.value)
                setError(null)
                setUnverified(null)
              }}
            />
            <p id="connect-model-note" className="connect-model__note">
              Saved on this computer and sent only to the provider.{' '}
              {KEY_URL[providerId] && (
                <a href={KEY_URL[providerId]} target="_blank" rel="noreferrer">
                  Get a key
                </a>
              )}
            </p>
          </>
        )}
        {!showReady && local && (
          <p className="connect-model__note">
            Houston will look for {provider?.label.replace(/^Local\W+/, '')} at{' '}
            <code>{provider?.baseUrl}</code>.
          </p>
        )}

        {error && (
          <p id="connect-model-error" className="connect-model__error" role="alert">
            {error}
          </p>
        )}
        {storageBlocked && <SecureStorageNotice platform={storageBlocked} />}

        <div className="onboard-card__actions">
          <button type="button" className="btn btn--sm" onClick={onBack}>
            Back
          </button>
          {unverified !== null && (
            <button type="button" className="btn btn--sm" onClick={() => void saveAnyway()} disabled={busy}>
              Save anyway
            </button>
          )}
          <button type="submit" className="btn btn--sm btn--accent" disabled={busy}>
            {showReady ? 'Use this model' : busy ? 'Checking…' : local ? 'Check connection' : 'Connect'}
          </button>
        </div>
      </form>
    </section>
  )
}
