import type { AppSettings, ProviderConfig } from './types'
import { DEFAULT_SEARCH_PROVIDER_ID } from './search'

export const SETTINGS_SCHEMA_VERSION = 3

/**
 * Default context-compaction threshold in tokens. Comfortable for large-context
 * cloud models (Claude/GPT/Gemini); small-context local models should lower it.
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
      // Labels are the lowercase model ids the provider's own model API returns, so a
      // seeded model reads the same as one added via Fetch.
      models: [
        { id: 'claude-fable-5', label: 'claude-fable-5' },
        { id: 'claude-opus-4-8', label: 'claude-opus-4.8' },
        { id: 'claude-sonnet-4-6', label: 'claude-sonnet-4.6' },
        { id: 'claude-haiku-4-5', label: 'claude-haiku-4.5' },
        { id: 'claude-opus-4-7', label: 'claude-opus-4.7' }
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
      models: [
        { id: 'gpt-5', label: 'gpt-5' },
        { id: 'gpt-5-mini', label: 'gpt-5-mini' },
        { id: 'gpt-5-nano', label: 'gpt-5-nano' },
        { id: 'gpt-4o', label: 'gpt-4o' },
        { id: 'gpt-4o-mini', label: 'gpt-4o-mini' },
        { id: 'o3', label: 'o3' },
        { id: 'o4-mini', label: 'o4-mini' }
      ],
      defaultModel: 'gpt-5',
      requiresKey: true,
      hasKey: false,
      builtIn: true
    },
    {
      id: 'gemini',
      kind: 'gemini',
      label: 'Google (Gemini)',
      models: [
        { id: 'gemini-2.5-pro', label: 'gemini-2.5-pro' },
        { id: 'gemini-2.5-flash', label: 'gemini-2.5-flash' },
        { id: 'gemini-2.0-flash', label: 'gemini-2.0-flash' }
      ],
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

export function defaultSettings(): AppSettings {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    providers: defaultProviders(),
    selected: null,
    approvalPolicy: 'ask',
    recentWorkspaces: [],
    compactionThreshold: DEFAULT_COMPACTION_THRESHOLD,
    shellOutputMaxBytes: DEFAULT_SHELL_OUTPUT_MAX_BYTES,
    reasoningEffort: 'off',
    permissionRules: [],
    hooks: [],
    mcpServers: [],
    additionalRoots: [],
    desktopNotifications: true,
    theme: 'system',
    searchProvider: DEFAULT_SEARCH_PROVIDER_ID
  }
}
