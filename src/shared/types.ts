/**
 * Core types shared between the main and renderer processes.
 *
 * IMPORTANT: nothing in here may carry a raw API key. The renderer only ever
 * learns whether a provider *has* a key (`hasKey`), never the key itself.
 */

export type ProviderKind = 'anthropic' | 'openai' | 'gemini' | 'openai-compatible'

export interface ModelOption {
  id: string
  label?: string
}

/** A configured model provider. Safe to send to the renderer. */
export interface ProviderConfig {
  /** Stable id. Built-ins use their kind name; custom endpoints use a generated id. */
  id: string
  kind: ProviderKind
  label: string
  /** Base URL. Required for `openai-compatible`; optional override for the others. */
  baseUrl?: string
  /** Known/curated model ids. Users can edit these or fetch live from the provider. */
  models: ModelOption[]
  defaultModel?: string
  /** Whether the provider needs an API key at all (local endpoints often don't). */
  requiresKey: boolean
  /** True when an encrypted key is stored for this provider. Derived, never persisted. */
  hasKey: boolean
  /** Built-in providers can't be deleted, only configured. */
  builtIn: boolean
}

/**
 * How aggressively the agent may act without asking.
 * - ask:       confirm every shell command and file write
 * - auto-edit: auto-approve reads/edits inside the workspace, ask for shell commands
 * - full-auto: auto-approve everything (still sandboxed to the workspace)
 */
export type ApprovalPolicy = 'ask' | 'auto-edit' | 'full-auto'

export interface SelectedModel {
  providerId: string
  model: string
}

export interface AppSettings {
  schemaVersion: number
  providers: ProviderConfig[]
  selected: SelectedModel | null
  approvalPolicy: ApprovalPolicy
  recentWorkspaces: string[]
  /** Optional extra instructions appended to the system prompt. */
  systemPromptExtra?: string
}
