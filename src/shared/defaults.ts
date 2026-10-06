import type { AppSettings, ProviderConfig, SelectedModel } from './types'
import { DEFAULT_SEARCH_PROVIDER_ID } from './search'
import { pickDefaultModel } from './models'

export const SETTINGS_SCHEMA_VERSION = 9

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
      // The current lineup, one model per tier. Superseded releases (Fable 5, Opus 4.8 /
      // 4.7, Sonnet 4.6) still serve, so the v9 migration only adds the new ids to
      // existing installs; it never removes a model a user may be using.
      models: [
        { id: 'claude-fable-5-1' },
        { id: 'claude-opus-5-5' },
        { id: 'claude-sonnet-5-5' },
        { id: 'claude-haiku-4-5' }
      ],
      // Changing this needs a live eval baseline for the new model in the same PR
      // (src/main/agent/evals/baselines/), or the scheduled eval-live.yml run reds.
      defaultModel: 'claude-opus-5-5',
      requiresKey: true,
      hasKey: false,
      builtIn: true
    },
    {
      id: 'openai',
      kind: 'openai',
      label: 'OpenAI (GPT)',
      // The GPT-6 line, one model per codename tier: astra (flagship), sol (near-astra at a
      // fifth of the price, so the default), luna (efficient). The GPT-5.x and o-series
      // models it supersedes still serve, so the v8 migration only adds these ids to
      // existing installs. Starting points only: the live list is a Fetch away, and the
      // display name derives from the id.
      models: [{ id: 'gpt-6-astra' }, { id: 'gpt-6.1-sol' }, { id: 'gpt-6-luna' }],
      defaultModel: 'gpt-6.1-sol',
      requiresKey: true,
      hasKey: false,
      builtIn: true
    },
    {
      id: 'gemini',
      kind: 'gemini',
      label: 'Google (Gemini)',
      // gemini-3.8-flash is the default: Google's newest stable model and its recommended
      // replacement for gemini-2.5-pro, which is now closed to new users (Google limits the
      // 2.5 line to accounts that already used it), so a fresh install defaulting to it
      // could only fail. gemini-3.1-pro-preview is seeded for the strongest reasoning even
      // though it is preview-only, since no stable 3.x Pro exists; it is a choice, never the
      // default. gemini-3.5-flash-lite is the current low-cost tier (3.1-flash-lite has an
      // announced 2027 shutdown). The v7 migration in store.ts adds these to existing
      // installs without pruning: 2.5-pro keeps working for the accounts that have it.
      //
      // NB the live /models list is NOT a safe source of truth here: it has listed retired
      // ids that 404 and models that could not serve under load. Only a real call proves a
      // model works, which is what the gemini leg of provider-canary.yml does nightly.
      models: [
        { id: 'gemini-3.1-pro-preview' },
        { id: 'gemini-3.8-flash' },
        { id: 'gemini-3.5-flash-lite' }
      ],
      defaultModel: 'gemini-3.8-flash',
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
 * Remove specific built-in default model ids from a saved provider list, matched by
 * provider id — the counterpart to `backfillDefaultModels`, for models a provider has
 * *retired*. This deliberately does NOT respect the "a model the user deletes stays
 * deleted" symmetry that scopes the backfill: these ids cannot be made to work (the
 * API 404s them), so keeping one only offers a menu entry that always fails. Only
 * providers whose id matches a built-in default are touched, so a custom endpoint or
 * proxy that happens to still serve the same model name is left exactly as it is.
 *
 * A `defaultModel` left dangling by the removal falls back to the built-in default;
 * a dangling top-level `selected` is reconciled separately by the settings migration
 * (`reconcileSelectedModel`).
 */
export function pruneDefaultModels(
  saved: ProviderConfig[],
  ids: readonly string[]
): ProviderConfig[] {
  const drop = new Set(ids)
  const defaults = new Map(defaultProviders().map((p) => [p.id, p]))
  return saved.map((p) => {
    const def = defaults.get(p.id)
    if (!def) return p
    const models = p.models.filter((m) => !drop.has(m.id))
    if (models.length === p.models.length) return p
    const next: ProviderConfig = { ...p, models }
    // A defaultModel pointing at a pruned (now-404) id would hand every new conversation
    // a model that can't answer, so fall back to the built-in default for this provider.
    if (next.defaultModel && drop.has(next.defaultModel)) next.defaultModel = def.defaultModel
    return next
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
