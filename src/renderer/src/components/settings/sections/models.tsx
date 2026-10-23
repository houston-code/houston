import { useMemo, useState } from 'react'
import type { AppSettings, ModelOption, ProviderConfig } from '@shared/types'
import { summarizeFetch, type FetchSummary } from '@shared/model-listing'
import {
  DEFAULT_SHELL_OUTPUT_MAX_BYTES,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_ITERATION_CEILING,
  autoExtendTurnsEnabled
} from '@shared/defaults'
import { SEARCH_PROVIDERS, DEFAULT_SEARCH_PROVIDER_ID, getSearchProviderInfo } from '@shared/search'
import { DEFAULT_SUBAGENT_HISTORY_MB } from '@shared/subagents'
import {
  catalogForPlatform,
  catalogEntryToProvider,
  customEndpointToProvider,
  customProviderId,
  DEFAULT_AZURE_API_VERSION,
  type CatalogEntry
} from '@shared/provider-catalog'
import { isMacPlatform } from '../../../lib/shortcuts'
import { HeadersField, ModelsField, SettingsSection } from '../fields'
import type { SettingsCtx } from '../context'

/** Configured providers: endpoint/region fields, the API key, and the model list. */
export function ProvidersSection({ ctx }: { ctx: SettingsCtx }): JSX.Element {
  const { settings, setSettings, busy, setBusy, keyInputs, setKeyInputs, setFormError, saveKey, removeKey } = ctx
  // Per provider: what its last "fetch from provider" changed, until the list is edited.
  const [fetchSummaries, setFetchSummaries] = useState<Record<string, FetchSummary>>({})

  const patchProvider = (id: string, patch: Partial<ProviderConfig>): void => {
    setSettings((s) => ({
      ...s,
      providers: s.providers.map((p) => (p.id === id ? { ...p, ...patch } : p))
    }))
  }

  const removeProvider = (id: string): void => {
    setSettings((s) => ({ ...s, providers: s.providers.filter((p) => p.id !== id) }))
  }

  const fetchModels = async (id: string): Promise<void> => {
    setBusy(id)
    setFormError(null)
    try {
      // listModels reads the provider's config from the persisted settings, so the
      // working edits must be saved first.
      await ctx.persistNow()
      const fetched = await window.api.listModels(id)
      // Adopt fetched ids + capability metadata, but keep any curated label the
      // user already had for that id (the listing rarely carries display labels).
      const provider = settings.providers.find((p) => p.id === id)
      const before = provider?.models ?? []
      const prev = new Map(before.map((m) => [m.id, m]))
      const models = fetched.map((m) => {
        const had = prev.get(m.id)
        return { ...m, label: m.label ?? had?.label, ...(had?.addedAt ? { addedAt: had.addedAt } : {}) }
      })
      patchProvider(id, { models })
      if (provider) {
        setFetchSummaries((all) => ({ ...all, [id]: summarizeFetch(provider.kind, before, models) }))
      }
    } catch (e) {
      setFormError(`Could not fetch models: ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  return (
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
            summary={fetchSummaries[p.id]}
            onFetch={() => fetchModels(p.id)}
            onChange={(models) => {
              // A hand edit makes the fetch summary stale; a blur that changed
              // nothing (tabbing through the field) leaves it.
              const ids = (list: ModelOption[]): string => list.map((m) => m.id).join('\n')
              if (ids(models) !== ids(p.models)) {
                setFetchSummaries(({ [p.id]: _stale, ...rest }) => rest)
              }
              patchProvider(p.id, { models })
            }}
          />
        </div>
      ))}
    </SettingsSection>
  )
}

/** Add a known host from the catalog, or any OpenAI-compatible endpoint. */
export function AddProviderSection({ ctx }: { ctx: SettingsCtx }): JSX.Element {
  const { settings, setSettings } = ctx
  const [newLabel, setNewLabel] = useState('')
  const [newUrl, setNewUrl] = useState('')

  // Known-host catalog for the "Add a provider" picker. Platform-filtered (e.g. the
  // Apple-Silicon oMLX preset is hidden off macOS); hosts already present are shown
  // disabled so they can't be added twice.
  const catalog = useMemo(() => catalogForPlatform(isMacPlatform()), [])
  const existingProviderIds = useMemo(
    () => new Set(settings.providers.map((p) => p.id)),
    [settings.providers]
  )

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

  return (
    <SettingsSection
      title="Add a provider"
      desc="Pick a known host, or point Houston at any OpenAI-compatible server, local or hosted."
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
                  {existingProviderIds.has(c.id) ? ' (added)' : ''}
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
                  {existingProviderIds.has(c.id) ? ' (added)' : ''}
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
  )
}

export function SystemPromptSection({ ctx }: { ctx: SettingsCtx }): JSX.Element {
  const { settings, setSettings } = ctx
  return (
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
  )
}

export function ContextWindowSection({ ctx }: { ctx: SettingsCtx }): JSX.Element {
  const { settings, setSettings } = ctx
  return (
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
  )
}

export function LoopControlSection({ ctx }: { ctx: SettingsCtx }): JSX.Element {
  const { settings, setSettings } = ctx
  return (
    <SettingsSection
      title="Loop control"
      desc="Guardrails for long agent turns: cap the work, nudge the model to land cleanly before the cap, catch unproductive loops, and optionally verify changes before the turn ends."
    >
      <label className="field">
        <span>
          Steps per turn (tool calls + replies). As the run nears this cap it&apos;s
          reminded to finish or summarize, so it lands cleanly instead of being cut off
          mid-edit.
        </span>
        <input
          type="number"
          min={1}
          step={1}
          value={settings.maxIterations ?? DEFAULT_MAX_ITERATIONS}
          onChange={(e) =>
            setSettings((s) => ({
              ...s,
              maxIterations: Math.max(1, Math.floor(Number(e.target.value) || 0)),
              // Pin the keep-going switch to what it showed, so setting a cap
              // never silently turns extension off (see autoExtendTurnsEnabled).
              autoExtendTurns: autoExtendTurnsEnabled(s)
            }))
          }
        />
      </label>
      <label className="field field--checkbox">
        <input
          type="checkbox"
          checked={autoExtendTurnsEnabled(settings)}
          onChange={(e) =>
            setSettings((s) => ({ ...s, autoExtendTurns: e.target.checked }))
          }
        />
        <span>
          Keep going while the turn is making progress: when it reaches the step cap
          while still editing files or finding out something new (and not looping),
          grant another round of steps instead of stopping.
        </span>
      </label>
      {autoExtendTurnsEnabled(settings) && (
        <label className="field">
          <span>Never run a single turn past this many steps, however productive.</span>
          <input
            type="number"
            min={1}
            step={10}
            value={settings.maxIterationsCeiling ?? DEFAULT_ITERATION_CEILING}
            onChange={(e) =>
              setSettings((s) => ({
                ...s,
                maxIterationsCeiling: Math.max(1, Math.floor(Number(e.target.value) || 0))
              }))
            }
          />
        </label>
      )}
      <label className="field">
        <span>
          Subagent history kept per chat, in MB: each subagent&apos;s steps, result
          previews and diffs. Past this, the oldest keep their task, step list and
          report but drop step results and diffs. 0 keeps summaries only.
        </span>
        <input
          type="number"
          min={0}
          step={1}
          value={settings.subagentHistoryMb ?? DEFAULT_SUBAGENT_HISTORY_MB}
          onChange={(e) =>
            setSettings((s) => ({
              ...s,
              subagentHistoryMb: Math.min(1024, Math.max(0, Number(e.target.value) || 0))
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
          Detect unproductive loops: repeating the same tool call, hitting the same error
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
          empty to disable; nothing runs unless you set this.
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
  )
}

export function ReasoningSection({ ctx }: { ctx: SettingsCtx }): JSX.Element {
  const { settings, setSettings } = ctx
  return (
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
  )
}

export function WebSearchSection({ ctx }: { ctx: SettingsCtx }): JSX.Element {
  const { settings, setSettings, busy, keyInputs, setKeyInputs, saveKey, removeKey } = ctx
  return (
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
              <p className="set-section__desc">
                Get a key at{' '}
                <a href={selected.keyUrl} target="_blank" rel="noreferrer">
                  {selected.keyUrl.replace(/^https:\/\//, '')}
                </a>
              </p>
            </label>
          </>
        )
      })()}
    </SettingsSection>
  )
}

export function ScorecardSection({ ctx }: { ctx: SettingsCtx }): JSX.Element | null {
  const { onShowScorecard } = ctx
  if (!onShowScorecard) return null
  return (
    <SettingsSection
      title="Loop scorecard"
      desc="See how each model has actually behaved across your chats: average steps, tool use, clean-finish rate, and cost. Aggregated on-device from your local data only, never sent anywhere."
    >
      <button type="button" className="btn" onClick={onShowScorecard}>
        Open loop scorecard
      </button>
    </SettingsSection>
  )
}
