import type { AppSettings, ProviderConfig } from './types'

export const SETTINGS_SCHEMA_VERSION = 1

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
      models: [
        { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
        { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
        { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
        { id: 'claude-opus-4-7', label: 'Claude Opus 4.7' }
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
        { id: 'gpt-4o', label: 'GPT-4o' },
        { id: 'gpt-4o-mini', label: 'GPT-4o mini' },
        { id: 'o3', label: 'o3' },
        { id: 'o4-mini', label: 'o4-mini' }
      ],
      defaultModel: 'gpt-4o',
      requiresKey: true,
      hasKey: false,
      builtIn: true
    },
    {
      id: 'gemini',
      kind: 'gemini',
      label: 'Google (Gemini)',
      models: [
        { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
        { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
        { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' }
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
    theme: 'system'
  }
}
