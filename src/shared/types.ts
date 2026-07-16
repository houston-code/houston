/**
 * Core types shared between the main and renderer processes.
 *
 * IMPORTANT: nothing in here may carry a raw secret. The renderer only ever learns
 * whether a provider *has* a key (`hasKey`), never the key itself. The same applies
 * to custom-header VALUES (`ProviderConfig.headers` / `McpServerConfig.headers`),
 * which can carry a bearer token: their real values live only in the encrypted
 * secrets store and are masked to `REDACTED_HEADER_VALUE` before a config leaves the
 * main process — see `src/main/store.ts` and `src/main/secrets.ts`.
 */

import type { ReasoningEffort, ReasoningSummary, Verbosity } from './agent'

export type ProviderKind = 'anthropic' | 'openai' | 'gemini' | 'openai-compatible'

/**
 * The placeholder the main process substitutes for every custom-header VALUE before
 * a `ProviderConfig` / `McpServerConfig` is handed to the renderer or written to
 * settings.json. Header values can carry a bearer token, so — like API keys — the
 * real values live only in the encrypted secrets store (see `src/main/secrets.ts`).
 *
 * The renderer shows this mask for a header that already has a stored value. On
 * save, a header whose value is still this mask (or empty — the on-disk redaction)
 * is treated as "unchanged" and its stored value is preserved; any other value is a
 * newly entered secret that replaces it. Renaming a header's key while leaving the
 * mask in place drops the value (there's nothing to carry forward under the new key).
 */
export const REDACTED_HEADER_VALUE = '••••••••'

/**
 * True for a header value that carries no secret: the on-disk redaction (empty) or the
 * renderer mask. Any all-bullet string counts, not just the exact mask, so an
 * accidental edit of the shown `••••••••` is still read as "unchanged" rather than
 * being stored verbatim as a bogus token.
 */
export function isRedactedHeaderValue(value: string): boolean {
  return value === '' || /^•+$/.test(value)
}

/** Secrets-store scope key for a provider's custom headers. */
export function providerHeaderScope(providerId: string): string {
  return `provider:${providerId}`
}

/** Secrets-store scope key for an MCP server's custom headers. */
export function mcpHeaderScope(serverId: string): string {
  return `mcp:${serverId}`
}

/** Secrets-store scope key for an MCP server's stdio environment variables. */
export function mcpEnvScope(serverId: string): string {
  return `mcp-env:${serverId}`
}

/**
 * How a provider authenticates.
 * - api-key: a static secret the user pastes in (the only flow wired up today).
 * - oauth:   an OAuth token set (access/refresh) obtained via an interactive flow.
 *            The credential store understands this shape, but the live flow is a
 *            stub pending registered client IDs — see `src/main/oauth.ts`.
 */
export type AuthMethod = 'api-key' | 'oauth'

/**
 * What a model can do, when known. Every field is optional: an absent field means
 * "unknown" — callers fall back to the name-heuristics in `usage.ts` rather than
 * treating absence as `false`. Populated from a host's model listing (e.g.
 * OpenRouter's `/models`) for models the curated heuristics don't recognize, like
 * `deepseek/deepseek-r1` or `google/gemma-3-27b`.
 */
export interface ModelCaps {
  /** Accepts tool / function calls. */
  tools?: boolean
  /** Accepts image inputs (multimodal vision). */
  vision?: boolean
  /** Has an extended-thinking / reasoning mode. */
  reasoning?: boolean
  /** Context window in tokens. */
  contextWindow?: number
  /**
   * Host-listed prices in USD per 1M tokens (converted from the per-token strings
   * rich hosts report). Exact where the name-heuristics in `usage.ts` are
   * approximations — and the only pricing available at all for host-routed models
   * the heuristics don't know (deepseek, qwen, …). `0` is meaningful (free-tier
   * routes bill nothing); absent means the host listed no price.
   */
  inputPrice?: number
  /** USD per 1M output tokens (see {@link ModelCaps.inputPrice}). */
  outputPrice?: number
  /** USD per 1M prompt-cache-read tokens; presence signals the route caches at all. */
  cacheReadPrice?: number
  /** USD per 1M prompt-cache-write tokens; `0` = writes are free. */
  cacheWritePrice?: number
}

export interface ModelOption {
  id: string
  label?: string
  /** Capability metadata captured from the host's model list. Absent for hand-typed ids. */
  caps?: ModelCaps
}

/** A configured model provider. Safe to send to the renderer. */
export interface ProviderConfig {
  /** Stable id. Built-ins use their kind name; custom endpoints use a generated id. */
  id: string
  kind: ProviderKind
  label: string
  /** Base URL. Required for `openai-compatible`; optional override for the others. */
  baseUrl?: string
  /**
   * Extra HTTP headers sent on every request to this provider — e.g. OpenRouter's
   * `HTTP-Referer`/`X-Title` attribution, or a gateway's custom auth header. Sent
   * in addition to the SDK's own `Authorization` (the API key). Honored on the
   * OpenAI / OpenAI-compatible and Anthropic paths (the ones that take a `baseUrl`).
   *
   * A header value can itself be a secret (a gateway bearer token), so the VALUES
   * are treated like the API key: they live only in the encrypted secrets store and
   * are merged in by the main process at request-build time (see
   * `src/main/providers/index.ts`). On any config that leaves the main process the
   * values are masked to `REDACTED_HEADER_VALUE`; only the header keys are visible.
   */
  headers?: Record<string, string>
  /** Known/curated model ids. Users can edit these or fetch live from the provider. */
  models: ModelOption[]
  defaultModel?: string
  /** Whether the provider needs an API key at all (local endpoints often don't). */
  requiresKey: boolean
  /**
   * How this provider authenticates. Defaults to `api-key` when absent. `oauth`
   * selects the OAuth credential shape in the secrets store; the live OAuth flow
   * is not yet implemented (see `src/main/oauth.ts`).
   */
  authMethod?: AuthMethod
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
/**
 * The valid approval policies, in escalating-trust order. Single source of truth:
 * the `ApprovalPolicy` type is derived from it, and runtime boundaries (CLI args,
 * IPC) validate against it so an unknown value can't silently fail open.
 */
export const APPROVAL_POLICIES = ['plan', 'ask', 'auto-edit', 'full-auto'] as const

export type ApprovalPolicy = (typeof APPROVAL_POLICIES)[number]

/** Runtime guard: true when `v` is a known approval policy. */
export function isApprovalPolicy(v: unknown): v is ApprovalPolicy {
  return typeof v === 'string' && (APPROVAL_POLICIES as readonly string[]).includes(v)
}

/**
 * An MCP (Model Context Protocol) server Houston connects to — a local process
 * over stdio, or a remote endpoint over streamable HTTP or the legacy HTTP+SSE
 * transport. Its tools are exposed to the agent namespaced as `mcp__<id>__<tool>`.
 * The server is user-configured and trusted; its tool calls still require approval.
 */
export interface McpServerConfig {
  /** Stable id, [\w-]+, used to namespace the server's tools. */
  id: string
  /** Display name (optional). */
  name?: string
  /**
   * Transport: a spawned local process ("stdio", default), a remote streamable-HTTP
   * endpoint ("http"), or the legacy HTTP+SSE endpoint ("sse"). "http"/"sse" use `url`.
   */
  transport?: 'stdio' | 'http' | 'sse'
  /** Executable to spawn (e.g. "npx"). stdio transport only. */
  command: string
  /** Arguments (e.g. ["-y", "@modelcontextprotocol/server-filesystem", "."]). stdio only. */
  args?: string[]
  /** Working directory for the spawned process. stdio only. */
  cwd?: string
  /**
   * Environment variables for the spawned process (e.g. an API token the server
   * needs). stdio only. The spawned server gets a credential-stripped base
   * environment, so anything it needs must be listed here explicitly. VALUES are
   * treated like header values: they live only in the encrypted secrets store
   * (scope `mcp-env:<id>`) and are masked on any config that leaves the main process.
   */
  env?: Record<string, string>
  /** Endpoint URL for the "http" (streamable) or "sse" transport (e.g. "https://host/mcp"). */
  url?: string
  /**
   * Extra HTTP headers sent on every request — e.g. a static bearer token
   * (`Authorization: Bearer …`) or a custom auth header. http/sse only. This is
   * fixed-header auth, not OAuth dynamic registration.
   *
   * Header VALUES can be secrets, so — like a provider's headers — they live only in
   * the encrypted secrets store and are merged in by the main process when the server
   * is connected (see `src/main/mcp/manager.ts`). On any config that leaves the main
   * process the values are masked to `REDACTED_HEADER_VALUE`; only the keys are shown.
   */
  headers?: Record<string, string>
  /**
   * True when an OAuth token set from the interactive sign-in is stored for this
   * server (http/sse). Derived like `ProviderConfig.hasKey`, never persisted.
   */
  hasOAuth?: boolean
  enabled: boolean
}

/**
 * Live connection status of a configured MCP server, as reported by the MCP
 * manager after its last connect attempt: for the settings UI and the TUI's /mcp
 * list. `needs-auth` means the server answered 401 and wants an OAuth sign-in.
 */
export interface McpServerStatus {
  id: string
  state: 'connected' | 'needs-auth' | 'error'
  /** Tool count, when connected. */
  tools?: number
  /** Failure detail, when not connected. */
  error?: string
}

/**
 * A lifecycle hook: a user-authored shell command run at a point in the agent
 * loop. The tool events (PreToolUse/PostToolUse) glob the tool name via `matcher`;
 * the lifecycle events (UserPromptSubmit/SessionStart/Stop/PreCompact) have no tool
 * and match only an empty or `*` matcher. A hook can steer the loop by printing a
 * JSON directive on stdout (block/approve, reason, additionalContext, updatedInput,
 * systemMessage); a non-zero exit blocks a blocking event, so exit-code-only hooks
 * keep working. See src/main/agent/hooks.ts.
 */
export interface Hook {
  event: 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'SessionStart' | 'Stop' | 'PreCompact'
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
  /**
   * Realpath-normalized workspace paths the user has opted out of the first-write
   * "Initialize git repository" prompt for ("Don't ask again for this folder").
   * Checked before showing the banner; appended to on opt-out.
   */
  gitInitDismissed?: string[]
  /** Optional extra instructions appended to the system prompt. */
  systemPromptExtra?: string
  /**
   * Compact the conversation when the estimated context exceeds this many tokens.
   * Unset means automatic: a fraction of the selected model's context window
   * (COMPACTION_WINDOW_FRACTION), falling back to a fixed default when the window
   * is unknown. Set a number to override that sizing; 0 disables compaction.
   */
  compactionThreshold?: number
  /**
   * Cap (bytes) on a single shell command's output fed back to the model, keeping
   * both ends. Guards the context window from one runaway command. Must be > 0;
   * falls back to DEFAULT_SHELL_OUTPUT_MAX_BYTES when unset or invalid.
   */
  shellOutputMaxBytes?: number
  /** Selected web-search provider id (see SEARCH_PROVIDERS). Defaults to Tavily. */
  searchProvider?: string
  /**
   * Per-provider "an API key is stored" flags, keyed by search-provider id. Derived
   * from the secrets store on every read, never persisted.
   */
  searchKeyStatus?: Record<string, boolean>
  /** How hard the model should think before answering (default `off`). */
  reasoningEffort?: ReasoningEffort
  /** How to request the reasoning summary, OpenAI Responses (default `auto`). */
  reasoningSummary?: ReasoningSummary
  /** Response verbosity, OpenAI Responses (default the model's own default). */
  verbosity?: Verbosity
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
  /**
   * Run a fast file-appropriate checker (eslint/ruff/pyflakes/gofmt) on a file
   * right after the agent writes it and feed any problems back so the model can
   * self-correct in the same turn. Read-only (never modifies the file); only fires
   * when the checker's binary is installed; off by default.
   */
  diagnosticsOnSave?: boolean
  /**
   * Hard cap on loop iterations for a single agent turn. When the run gets within
   * a small margin of this cap it's nudged to "land" (finish or summarize) rather
   * than being cut off mid-edit. Falls back to DEFAULT_BUDGET_LIMITS.maxIterations
   * when unset; clamped to at least 1.
   */
  maxIterations?: number
  /**
   * Cumulative USD cost ceiling for a single run. Once the run's accumulated
   * per-turn cost crosses this, it gets the same one-time "land" nudge as the
   * iteration margin. 0/unset disables the cost-based trigger.
   */
  costCeilingUsd?: number
  /**
   * Enable stall / loop detection. When the model cycles unproductively (repeats
   * the same tool call, keeps hitting the same error, or makes no file change for
   * several turns), inject one corrective reminder; if it persists, stop the run.
   * On by default.
   */
  stallDetection?: boolean
  /**
   * End-of-run verification gate (opt-in). When the model stops naturally after
   * modifying files, run {@link verifyCommand} and, if it fails, feed the output
   * back for a bounded number of self-correction passes before accepting done.
   * Off by default and inert unless a command is configured.
   */
  verifyOnStop?: boolean
  /** Stall detection: same (tool,args) repeated this many times → stall (min 2). */
  stallRepeatCallLimit?: number
  /** Stall detection: same error signature this many times → stall (min 2). */
  stallRepeatErrorLimit?: number
  /**
   * The verification command run by the end-of-run gate (e.g. `npm run typecheck`
   * or `npm test`). Runs through the same sandbox as `run_shell`. Never inferred:
   * the gate does nothing unless the user sets this explicitly.
   */
  verifyCommand?: string
  /** Max extra self-correction passes the verification gate allows (bounded). */
  verifyMaxPasses?: number
  /** MCP servers to connect to (stdio). Their tools are offered to the agent. */
  mcpServers?: McpServerConfig[]
  /**
   * Execute the opened project's `.houston/plugins/*.js` files. OFF by default and
   * deliberately opt-in: plugins are evaluated in-process and `vm` is NOT a security
   * boundary, so a plugin file shipped in an untrusted repo is arbitrary code
   * execution in the main process. Only enable this for projects you fully trust.
   */
  projectPlugins?: boolean
  /** Extra directories (beyond the project folder) the agent may read and write. */
  additionalRoots?: string[]
  /**
   * Show a native desktop notification when the agent finishes, needs approval,
   * asks a question, or opens/merges a pull request while Houston isn't the
   * focused window. On by default.
   */
  desktopNotifications?: boolean
  /** UI color theme (default follows the OS). */
  theme?: 'system' | 'dark' | 'light'
  /** User-defined sidebar groups, in display order. */
  chatGroups?: ChatGroup[]
  /**
   * Collapsed state for the sidebar's built-in sections, keyed by section id
   * ('pinned', 'ungrouped'). Custom groups keep their own collapsed flag on the
   * group; these two aren't groups, so their state lives here. Absent = expanded.
   */
  collapsedSections?: Record<string, boolean>
  /**
   * Width (px) of the left sidebar. Clamped to [SIDEBAR_MIN_WIDTH,
   * SIDEBAR_MAX_WIDTH] on read; falls back to SIDEBAR_DEFAULT_WIDTH when unset.
   */
  sidebarWidth?: number
  /** Whether the sidebar is collapsed to a thin rail. */
  sidebarCollapsed?: boolean
  /**
   * User keyboard-shortcut overrides, keyed by shortcut id (see the renderer's
   * shortcut registry). A chord string (e.g. "mod+k") rebinds the shortcut; null
   * disables it; an absent key keeps the default. Only customizable (single-chord,
   * global) shortcuts appear here.
   */
  keybindings?: Record<string, string | null>
  /** Height (px) of the integrated terminal panel. */
  terminalHeight?: number
  /** Whether the integrated terminal panel is open. */
  terminalOpen?: boolean
  /** Width (px) of the right-hand preview panel. */
  previewWidth?: number
  /** Whether the preview panel is open. */
  previewOpen?: boolean
  /** Width (px) of the docked plan-review panel (Plan mode). */
  planWidth?: number
  /**
   * Highest legal-terms version (see LEGAL_VERSION in @shared/legal) the user has
   * accepted via the first-run gate. Absent/older than LEGAL_VERSION means the
   * Terms of Use, Privacy Policy, and License must be (re)accepted before use.
   */
  legalAcceptedVersion?: number
}

/** One format-on-save backend and whether its binary is present on this machine. */
export interface FormatterStatus {
  /** Binary name, e.g. `prettier`, `gofmt`, `ruff`. */
  bin: string
  /** Found on PATH or a standard install dir. */
  installed: boolean
  /** File extensions it formats, e.g. `['ts', 'tsx', 'json']`. */
  languages: string[]
}

/**
 * Runtime status of OPTIONAL external integrations, surfaced in Settings as a hint.
 * These are never required — Houston degrades gracefully without them — but the UI
 * shows whether each is available and how to enable it.
 */
export interface IntegrationsInfo {
  /** The `gh` CLI, used by the `gh_*` GitHub tools. */
  gh: {
    /** `gh` binary found. */
    installed: boolean
    /** `gh auth status` succeeded — only meaningful when `installed`. */
    authenticated: boolean
  }
  /** Format-on-save backends and whether each is installed. */
  formatters: FormatterStatus[]
}
