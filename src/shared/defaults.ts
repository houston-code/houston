import type { ReasoningEffort } from './agent'
import type { AppSettings, ApprovalPolicy, ProviderConfig, SelectedModel } from './types'
import { DEFAULT_SEARCH_PROVIDER_ID } from './search'
import { pickDefaultModel } from './models'

export const SETTINGS_SCHEMA_VERSION = 14

/**
 * The reasoning effort a fresh install starts at. Coding and long agentic turns are the
 * work that gains most from deeper thinking, so the default leans toward a correct first
 * attempt over a cheaper step. It costs more output tokens and time per step than a
 * low setting; the reasoning menu and `/reasoning` turn it down.
 */
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'high'

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
 * Default absolute step cap for a turn that keeps auto-extending past
 * DEFAULT_MAX_ITERATIONS because it is still making progress.
 */
export const DEFAULT_ITERATION_CEILING = 200

/**
 * Whether a productive turn may run past its step cap. An explicit setting wins.
 * Unset, it is on only when the cap is also unset: a user who chose a cap before
 * extension existed chose a hard stop, and keeps one until they opt in. The
 * Settings UI writes the switch explicitly whenever the cap is edited, so editing
 * the cap never flips it silently.
 */
export function autoExtendTurnsEnabled(
  settings: Pick<AppSettings, 'autoExtendTurns' | 'maxIterations'>
): boolean {
  return settings.autoExtendTurns ?? settings.maxIterations === undefined
}

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
      // 4.7, Sonnet 4.6, Haiku 4.5) still serve, so the migrations that brought in their
      // successors (v9, v12) only add new ids; they never remove a model a user may be using.
      models: [
        { id: 'claude-fable-5-1' },
        { id: 'claude-opus-5-5' },
        { id: 'claude-sonnet-5-5' },
        { id: 'claude-haiku-5-5' }
      ],
      // The scheduled eval-live.yml run scores claude-haiku-5-5, not this, so changing it
      // breaks nothing in CI. Scoring the new default (a dispatch with its model id, or a
      // local live run with no HOUSTON_EVAL_MODEL) needs a baseline for it first:
      // HOUSTON_EVAL_MODEL=<id> npm run eval:baseline.
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
      // gemini-3.8-flash is the default: Google's newest stable Flash, fast and cheap for
      // agent turns. gemini-4-argon is Google's flagship reasoning model, seeded for hard
      // work but not the default: it costs more (introductory $2/$10, then $4/$20 from
      // 2026-12-01) and Google warns hard prompts can take minutes. It replaced
      // gemini-3.1-pro-preview in the seed. gemini-3.5-flash-lite is the low-cost tier.
      // Migrations only add ids to existing installs (v7, v13); nothing is pruned, since
      // the models they supersede still serve, except 2.5-pro for new users.
      //
      // NB the live /models list is NOT a safe source of truth here: it has listed retired
      // ids that 404 and models that could not serve under load. Only a real call proves a
      // model works, which is what the gemini leg of provider-canary.yml does nightly.
      models: [
        { id: 'gemini-4-argon' },
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
      label: 'Ollama (local)',
      baseUrl: 'http://localhost:11434/v1',
      models: [],
      requiresKey: false,
      hasKey: false,
      builtIn: true
    },
    {
      id: 'lmstudio',
      kind: 'openai-compatible',
      label: 'LM Studio (local)',
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
  onlyIds?: readonly string[],
  now: Date = new Date()
): ProviderConfig[] {
  const only = onlyIds ? new Set(onlyIds) : null
  // A scoped add is a version bump delivering newly released models, so stamp them for
  // the picker's "New" mark. The full first-run/pre-v2 seed is not news and stays unstamped.
  const addedAt = only ? now.toISOString().slice(0, 10) : undefined
  const defaults = new Map(defaultProviders().map((p) => [p.id, p]))
  return saved.map((p) => {
    const def = defaults.get(p.id)
    if (!def) return p
    const have = new Set(p.models.map((m) => m.id))
    const additions = def.models
      .filter((m) => !have.has(m.id) && (!only || only.has(m.id)))
      .map((m) => (addedAt ? { ...m, addedAt } : m))
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

/** Built-in provider names older versions seeded, keyed by provider id, mapped to the current name. */
const RENAMED_BUILT_IN_LABELS: Record<string, { from: string; to: string }> = {
  ollama: { from: 'Local \u2014 Ollama', to: 'Ollama (local)' },
  lmstudio: { from: 'Local \u2014 LM Studio', to: 'LM Studio (local)' }
}

/**
 * Rename built-in providers whose saved name is exactly a name an older version seeded.
 * The display name is persisted with the provider, so changing the seed alone would only
 * reach fresh installs. A name the user has changed is left as they set it.
 */
export function renameBuiltInProviderLabels(saved: ProviderConfig[]): ProviderConfig[] {
  return saved.map((p) => {
    const rename = RENAMED_BUILT_IN_LABELS[p.id]
    return p.builtIn && rename && p.label === rename.from ? { ...p, label: rename.to } : p
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

/**
 * The approval mode a fresh install starts in. Where the OS sandbox confines shell
 * commands to the project, full-auto runs edits and commands without asking: network,
 * MCP, commands that reach outside the project, and commands that can throw away work
 * still ask in every mode. Without a sandbox every command would run unconfined, so a
 * fresh install there starts in ask. Existing installs keep the mode they saved.
 */
export function freshInstallApprovalPolicy(sandboxed: boolean): ApprovalPolicy {
  return sandboxed ? 'full-auto' : 'ask'
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
    reasoningEffort: DEFAULT_REASONING_EFFORT,
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
