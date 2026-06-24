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
 * An MCP (Model Context Protocol) server Houston connects to — either a local
 * process over stdio, or a remote endpoint over streamable HTTP. Its tools are
 * exposed to the agent namespaced as `mcp__<id>__<tool>`. The server is
 * user-configured and trusted; its tool calls still require approval.
 */
export interface McpServerConfig {
  /** Stable id, [\w-]+, used to namespace the server's tools. */
  id: string
  /** Display name (optional). */
  name?: string
  /** Transport: a spawned local process ("stdio", default) or a remote HTTP endpoint. */
  transport?: 'stdio' | 'http'
  /** Executable to spawn (e.g. "npx"). stdio transport only. */
  command: string
  /** Arguments (e.g. ["-y", "@modelcontextprotocol/server-filesystem", "."]). stdio only. */
  args?: string[]
  /** Endpoint URL for the streamable-HTTP transport (e.g. "https://host/mcp"). http only. */
  url?: string
  /** Extra HTTP headers to send (e.g. an Authorization token). http only. */
  headers?: Record<string, string>
  enabled: boolean
}

/**
 * A tool-use hook: a shell command run before (PreToolUse) or after (PostToolUse)
 * a tool call. PreToolUse can block the call by exiting non-zero; PostToolUse
 * output is appended to the tool result. `matcher` is a glob over the tool name
 * (empty or `*` = all tools).
 */
export interface Hook {
  event: 'PreToolUse' | 'PostToolUse'
  matcher: string
  command: string
}

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

/**
 * A user-defined sidebar group ("folder") that chats can be filed into. Definitions
 * (and collapsed state) are app-level and persisted in settings; which group a chat
 * belongs to is stored on the conversation itself (ConversationMeta.groupId).
 */
export interface ChatGroup {
  id: string
  name: string
  /** Whether the group is collapsed in the sidebar. */
  collapsed?: boolean
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
  /** Shell hooks run before/after tool calls. */
  hooks?: Hook[]
  /**
   * Run the matching formatter (prettier/gofmt/rustfmt/ruff/black/…) on a file
   * right after the agent writes it, the way an editor formats on save. Only fires
   * when the formatter's binary is installed; off by default.
   */
  formatOnSave?: boolean
  /** MCP servers to connect to (stdio). Their tools are offered to the agent. */
  mcpServers?: McpServerConfig[]
  /** Extra directories (beyond the project folder) the agent may read and write. */
  additionalRoots?: string[]
  /** UI color theme (default follows the OS). */
  theme?: 'system' | 'dark' | 'light'
  /** User-defined sidebar groups, in display order. */
  chatGroups?: ChatGroup[]
}
