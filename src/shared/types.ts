/**
 * Core types shared between the main and renderer processes.
 *
 * IMPORTANT: nothing in here may carry a raw API key. The renderer only ever
 * learns whether a provider *has* a key (`hasKey`), never the key itself.
 */

import type { ReasoningEffort } from './agent'

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
 * - plan:      read-only — the agent researches and proposes a plan; writes and
 *              shell commands are blocked until you switch out of plan mode
 * - ask:       confirm every shell command and file write
 * - auto-edit: auto-approve reads/edits inside the workspace, ask for shell commands
 * - full-auto: auto-approve everything (still sandboxed to the workspace)
 */
export type ApprovalPolicy = 'plan' | 'ask' | 'auto-edit' | 'full-auto'

/**
 * A fine-grained permission rule, consulted before the approval policy. Matches a
 * tool (by name, or `*` for any) and a glob over the call's subject (shell
 * command, path, URL, or query). First match wins.
 */
export interface PermissionRule {
  action: 'allow' | 'deny' | 'ask'
  /** Tool name, or `*` for any tool. */
  tool: string
  /** Glob over the call's subject. Empty or `*` matches anything for that tool. */
  match: string
}

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
  /**
   * Compact the conversation when the estimated context exceeds this many tokens.
   * 0 disables compaction. Lower it for small-context local models.
   */
  compactionThreshold?: number
  /** True when a web-search (Tavily) API key is stored. Derived, never persisted. */
  hasWebSearchKey?: boolean
  /** How hard the model should think before answering (default `off`). */
  reasoningEffort?: ReasoningEffort
  /** Fine-grained permission rules, consulted before the approval policy. */
  permissionRules?: PermissionRule[]
}
