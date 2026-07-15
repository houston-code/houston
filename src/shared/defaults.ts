import type { AppSettings, ProviderConfig, SelectedModel } from './types'
import { DEFAULT_SEARCH_PROVIDER_ID } from './search'
import { pickDefaultModel } from './models'

export const SETTINGS_SCHEMA_VERSION = 5

/**
 * Fallback context-compaction threshold in tokens, used only when the selected
 * model's context window is unknown (a custom/local model with no capability
 * metadata). When the window IS known, the threshold scales to it instead — see
 * `resolveCompactionThreshold` in main/agent/compaction.ts. An explicit
 * `compactionThreshold` setting overrides both.
 */
export const DEFAULT_COMPACTION_THRESHOLD = 100_000

/**
 * Default cap (bytes) on a single shell command's output fed back to the model.
 * Far tighter than the 1 MB per-stream capture cap in sandbox.ts: that one stops
 * capture from exhausting memory, but 1 MB of stdout is ~250k tokens, so one
 * runaway command (an `npm install` log, a screenful of `Operation not
 * permitted`) would overflow the context window in a single turn before any
 * compaction can run. Both ends are kept on truncation. ~16k tokens.
 */
export const DEFAULT_SHELL_OUTPUT_MAX_BYTES = 64_000

/**
 * Default hard cap on loop iterations for a single agent turn. Shared between the
 * agent loop's budget resolver and the Settings UI so they show the same figure.
 */
export const DEFAULT_MAX_ITERATIONS = 40

/**
 * Resolve the effective shell-output budget: a positive user override, otherwise
 * the default. Guards against 0 / negatives, which would truncate everything.
 */
export function resolveShellOutputBudget(
  settings: Pick<AppSettings, 'shellOutputMaxBytes'>
): number {
  const v = settings.shellOutputMaxBytes
  return typeof v === 'number' && v > 0 ? Math.floor(v) : DEFAULT_SHELL_OUTPUT_MAX_BYTES
}

/**
 * Built-in providers seeded on first run. Model lists are starting points only —
 * users can edit them or fetch the live list from each provider in Settings.
 */
export function defaultProviders(): ProviderConfig[] {
  return [
    {
      id: 'anthropic',
      kind: 'anthropic',
      label: 'Anthropic (Claude)',
      // Model ids only — the display name is derived from the id (see
      // `modelDisplayName` in models.ts), so a seeded model reads identically to one
      // added via Fetch. No hardcoded labels to drift out of sync with fetched ids.
      models: [
        { id: 'claude-fable-5' },
        { id: 'claude-opus-4-8' },
        { id: 'claude-sonnet-4-6' },
        { id: 'claude-haiku-4-5' },
        { id: 'claude-opus-4-7' }
      ],
      defaultModel: 'claude-opus-4-8',
      requiresKey: true,
      hasKey: false,
      builtIn: true
    },
    {
      id: 'openai',
      kind: 'openai',
      label: 'OpenAI (GPT)',
      // Current GPT-5.x line: the gpt-5.6 flagship family (sol/terra/luna tiers) plus a
      // couple of recent still-available versions, and o3 for reasoning. Starting points
      // only — the live list is a Fetch away, and the display name derives from the id.
      models: [
        { id: 'gpt-5.6-sol' },
        { id: 'gpt-5.6-terra' },
        { id: 'gpt-5.6-luna' },
        { id: 'gpt-5.5' },
        { id: 'gpt-5.4' },
        { id: 'o3' }
      ],
      defaultModel: 'gpt-5.6-sol',
      requiresKey: true,
      hasKey: false,
      builtIn: true
    },
    {
      id: 'gemini',
      kind: 'gemini',
      label: 'Google (Gemini)',
      models: [{ id: 'gemini-2.5-pro' }, { id: 'gemini-2.5-flash' }, { id: 'gemini-2.0-flash' }],
      defaultModel: 'gemini-2.5-pro',
      requiresKey: true,
      hasKey: false,
      builtIn: true
    },
    {
      id: 'ollama',
      kind: 'openai-compatible',
      label: 'Local — Ollama',
      baseUrl: 'http://localhost:11434/v1',
      models: [],
      requiresKey: false,
      hasKey: false,
      builtIn: true
    },
    {
      id: 'lmstudio',
      kind: 'openai-compatible',
      label: 'Local — LM Studio',
      baseUrl: 'http://localhost:1234/v1',
      models: [],
      requiresKey: false,
      hasKey: false,
      builtIn: true
    }
  ]
}

/**
 * Union newly-added built-in default models into a saved provider list, matched by
 * provider id. The curated model lists are a starting point that grows as providers
 * ship new models (e.g. GPT-5); this lets the settings migration backfill those into
 * existing installs without clobbering a user's own edits or re-adding models they've
 * deleted. Only providers whose id matches a built-in default are touched — custom
 * endpoints and the local providers' empty lists are left exactly as the user left
 * them. New default models are appended, so the user's ordering and `defaultModel`
 * are preserved.
 *
 * `onlyIds` scopes the backfill to a specific set of model ids. A later schema bump
 * that introduces a single new default (e.g. a new Claude model) passes it so the
 * upgrade adds just that model — a full backfill would re-add every other default the
 * user has since deleted, which the version-gated migration exists to prevent. Omit it
 * for the first-run/pre-v2 path, which seeds the whole default set.
 */
export function backfillDefaultModels(
  saved: ProviderConfig[],
  onlyIds?: readonly string[]
): ProviderConfig[] {
  const only = onlyIds ? new Set(onlyIds) : null
  const defaults = new Map(defaultProviders().map((p) => [p.id, p]))
  return saved.map((p) => {
    const def = defaults.get(p.id)
    if (!def) return p
    const have = new Set(p.models.map((m) => m.id))
    const additions = def.models.filter((m) => !have.has(m.id) && (!only || only.has(m.id)))
    return additions.length ? { ...p, models: [...p.models, ...additions] } : p
  })
}

/**
 * Drop stored per-model `label` overrides from built-in providers so their display
 * names come from `modelDisplayName` (derived from the id) instead of a stale
 * hardcoded string a past version seeded. Built-in labels used to be a mix of
 * title-case ("Claude Opus 4.8") and dotted-id ("claude-opus-4.8") forms that never
 * matched what a live Fetch returns (raw ids, no label) — so the same provider's
 * list read inconsistently. This normalizes existing installs to one convention per
 * provider. Custom endpoints (`builtIn: false`) keep any label the user set.
 */
export function stripBuiltInModelLabels(saved: ProviderConfig[]): ProviderConfig[] {
  return saved.map((p) => {
    if (!p.builtIn || !p.models.some((m) => m.label !== undefined)) return p
    return { ...p, models: p.models.map(({ label: _label, ...m }) => m) }
  })
}

/**
 * Keep `selected` pointing at a model that still exists. When the user removes the
 * selected model (or its whole provider) from settings, the stale selection would
 * otherwise linger and the picker would render an unusable, removed id. Reconcile:
 *   - the selection still resolves to a real provider + model → keep it.
 *   - its provider survives but that model is gone → fall back to the provider's
 *     default (or first) model, so the user stays on the same provider.
 *   - the provider itself is gone or now has no models → clear it (null); the picker
 *     then shows "Select a model…", and load-time defaulting re-fills a ready one.
 * A null selection is left null: choosing an initial default is the caller's job.
 */
export function reconcileSelectedModel(
  providers: ProviderConfig[],
  selected: SelectedModel | null
): SelectedModel | null {
  if (!selected) return null
  const provider = providers.find((p) => p.id === selected.providerId)
  if (!provider || provider.models.length === 0) return null
  if (provider.models.some((m) => m.id === selected.model)) return selected
  // The selected model was removed. Re-point within the same provider, guarding against
  // a `defaultModel` that pointed at the just-removed id.
  return { providerId: provider.id, model: pickDefaultModel(provider) ?? provider.models[0].id }
}

export function defaultSettings(): AppSettings {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    providers: defaultProviders(),
    selected: null,
    approvalPolicy: 'ask',
    recentWorkspaces: [],
    // compactionThreshold is deliberately unset: absent means "automatic"
    // (window-relative — see resolveCompactionThreshold); only a user's explicit
    // override is ever stored.
    shellOutputMaxBytes: DEFAULT_SHELL_OUTPUT_MAX_BYTES,
    reasoningEffort: 'off',
    stallDetection: true,
    permissionRules: [],
    hooks: [],
    mcpServers: [],
    additionalRoots: [],
    desktopNotifications: true,
    theme: 'system',
    searchProvider: DEFAULT_SEARCH_PROVIDER_ID
  }
}
