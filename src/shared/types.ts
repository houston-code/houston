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

import type { OnboardingState } from './onboarding'
import type { ReasoningEffort, ReasoningSummary, Verbosity } from './agent'
import type { SandboxEgressSettings } from './egress'

/**
 * How a provider talks to its host. `bedrock`, `vertex` and `foundry` are the
 * cloud-hosted Claude backends: they speak the same Messages protocol as `anthropic`
 * (their SDK clients all extend `BaseAnthropic`, so they share one adapter — see
 * `src/main/providers/anthropic.ts`) but address models by the host's id convention,
 * and the first two resolve credentials from the cloud's own chain rather than an API
 * key. `azure-openai` is the same idea one family over: an `AzureOpenAI` client that
 * extends `OpenAI`, so it shares the Chat Completions adapter in
 * `src/main/providers/openai.ts` and only differs in how the client is built.
 */
export type ProviderKind =
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'openai-compatible'
  | 'bedrock'
  | 'vertex'
  | 'azure-openai'
  | 'foundry'

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
  /** Release date the host's listing reports (`YYYY-MM-DD`); drives the picker's "New" mark. */
  releasedAt?: string
}

export interface ModelOption {
  id: string
  label?: string
  /** Capability metadata captured from the host's model list. Absent for hand-typed ids. */
  caps?: ModelCaps
  /**
   * When a settings migration added this model to the user's list (`YYYY-MM-DD`). Unset
   * for models seeded on first run or added by hand, so only a model that arrived in an
   * update reads as "New" in the picker.
   */
  addedAt?: string
  /**
   * When a request for this model last came back "not found" from its provider
   * (`YYYY-MM-DD`): an id that was mistyped, retired, or isn't open to this key. Cleared
   * the next time the model answers a request. The pickers flag it.
   */
  unavailableAt?: string
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
   * Cloud region for the hosted-Claude kinds. Bedrock resolves it as `region` arg >
   * `AWS_REGION` > `AWS_DEFAULT_REGION`; Vertex as `region` arg > `CLOUD_ML_REGION`.
   * Both build their endpoint from it, so a provider with neither this nor the
   * matching env var set can't address a host at all (see `createProvider`). Ignored
   * by the other kinds, which carry their region in `baseUrl` when they have one.
   */
  region?: string
  /**
   * Google Cloud project that bills and serves Vertex requests. Falls back to
   * `ANTHROPIC_VERTEX_PROJECT_ID`, then to the project on the resolved ADC
   * credentials — so it's usually inferable and left blank. Vertex-only.
   */
  projectId?: string
  /**
   * Azure OpenAI resource endpoint, e.g. `https://my-resource.openai.azure.com`.
   * Houston derives the request URL from it (`{endpoint}/openai/deployments/...`),
   * falling back to `AZURE_OPENAI_ENDPOINT`. `azure-openai` only; a `baseUrl` set
   * alongside it wins, for a gateway that fronts the resource.
   */
  endpoint?: string
  /**
   * Azure OpenAI REST API version, sent as the `api-version` query parameter. Azure
   * pins request/response shape to it rather than serving one evergreen API, so it
   * is a required part of the address and every deployment is reachable only at a
   * version that supports it. Pre-filled on add; newer models need a newer version.
   * `azure-openai` only.
   */
  apiVersion?: string
  /**
   * Microsoft Foundry resource name, e.g. `my-resource` for
   * `https://my-resource.services.ai.azure.com/anthropic/`. Falls back to
   * `ANTHROPIC_FOUNDRY_RESOURCE`. `foundry` only; a `baseUrl` set alongside it wins.
   */
  resource?: string
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
 * Each policy's name as the user sees it, in both clients: the desktop's approval
 * menu and the terminal's `/approval` both print these, never the ids.
 */
export const APPROVAL_POLICY_LABEL: Record<ApprovalPolicy, string> = {
  plan: 'Plan mode (read-only)',
  ask: 'Ask every time',
  'auto-edit': 'Auto-approve edits',
  'full-auto': 'Full auto'
}

/**
 * The approval policy a typed word names: an id (`auto-edit`), or the short command
 * names both clients accept (`/auto`, `/full`). Case-insensitive; null when it names
 * none, so a typo never silently picks a policy.
 */
export function parseApprovalPolicy(word: string): ApprovalPolicy | null {
  const w = word.trim().toLowerCase()
  if (isApprovalPolicy(w)) return w
  if (w === 'auto') return 'auto-edit'
  if (w === 'full') return 'full-auto'
  return null
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
  /**
   * Where the config came from. 'project' marks a trusted folder's
   * `.houston/settings.json` server, merged in at the run seam under a `proj-`
   * id prefix: its header/env VALUES are read from the config verbatim (they are
   * already plaintext in the repo by its author's choice) instead of the user's
   * secret store, and it is never persisted into the user's settings. Absent
   * means a user-configured server.
   */
  origin?: 'project'
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
  /**
   * The tool names, when connected. A count answers "is it working"; the names
   * answer "what did I just give the agent", which is the question that matters
   * when you are deciding whether to trust a server.
   */
  toolNames?: string[]
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

/** The valid hook events, in display order — the one list validators and UIs share. */
export const HOOK_EVENTS: Hook['event'][] = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'SessionStart',
  'Stop',
  'PreCompact'
]

/**
 * A per-folder decision about honoring that project's ELEVATING config — the
 * `allow` rules, hooks, and MCP servers a `.houston/settings.json` may define
 * but which are ignored until the user trusts the folder (they auto-approve
 * actions or run processes, so an untrusted clone must not get them).
 *
 * `hash` fingerprints the elevating subset the decision covered: when a trusted
 * folder's project file later changes that subset, the trust no longer applies
 * and the user is asked again ("changed"). `never` permanently suppresses both
 * the elevation and the prompt for this folder.
 */
export interface FolderTrust {
  /** Realpath-normalized workspace path. */
  path: string
  decision: 'trusted' | 'never'
  /** Fingerprint of the elevating config the decision covered (see projectConfig.ts). */
  hash: string
  /** Epoch ms of the decision. */
  decidedAt: number
}

/** Where a folder stands: honored, refused, awaiting a decision, or drifted since trust. */
export type FolderTrustState = 'trusted' | 'untrusted' | 'undecided' | 'changed'

/**
 * What the trust-consent UI needs to render for a workspace: 'none' when the
 * project elevates nothing (no prompt at all), else the trust state plus how
 * many of each elevating item the project defines (shown so the user consents
 * to something concrete).
 */
export interface FolderTrustStatus {
  state: FolderTrustState | 'none'
  counts?: { allowRules: number; hooks: number; mcpServers: number }
}

/**
 * The permission configuration that applies alongside the user's own, for
 * Settings to show read-only: the administrator's managed policy and the open
 * project's `.houston/settings.json`. Only what the user needs to read; a project
 * MCP server's header and env values (which may hold tokens) never leave main.
 */
export interface PermissionPolicyView {
  /** Admin guardrails (deny/ask), checked before everything else. */
  managed: PermissionRule[]
  /** The open project's config, or null when it has none (or no project is open). */
  project: {
    /** Project guardrails (deny/ask), always applied, checked after the admin's. */
    rules: PermissionRule[]
    /** Elevating config, applied only while `trust` is 'trusted'. */
    allowRules: PermissionRule[]
    hooks: Hook[]
    mcpServers: Array<{ id: string; transport: 'stdio' | 'http' | 'sse'; target: string }>
    trust: FolderTrustState | 'none'
  } | null
}

/**
 * Resolve a folder's trust state for the elevating config currently on disk.
 * `path` must already be realpath-normalized by the caller (the same discipline
 * as `gitInitDismissed`), and `hash` is the CURRENT elevated-config fingerprint.
 * Pure so every client resolves trust identically.
 */
export function folderTrustState(
  records: FolderTrust[] | undefined,
  path: string,
  hash: string
): FolderTrustState {
  const rec = records?.find((r) => r.path === path)
  if (!rec) return 'undecided'
  if (rec.decision === 'never') return 'untrusted'
  return rec.hash === hash ? 'trusted' : 'changed'
}

/** Upsert a folder's trust decision (immutable; keyed by realpath-normalized path). */
export function upsertFolderTrust(
  records: FolderTrust[] | undefined,
  entry: FolderTrust
): FolderTrust[] {
  return [...(records ?? []).filter((r) => r.path !== entry.path), entry]
}

/**
 * Forget a folder's trust decision (immutable). The folder returns to
 * 'undecided', so the consent banner/prompt asks again on next open — the one
 * way to reverse a "Never" (or retire a stale "Trust") without hand-editing
 * settings.json.
 */
export function removeFolderTrust(
  records: FolderTrust[] | undefined,
  path: string
): FolderTrust[] {
  return (records ?? []).filter((r) => r.path !== path)
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
  /**
   * Glob over the call's subject. Empty matches nothing; `*` matches anything for that
   * tool. With {@link exact}, the literal subject instead.
   */
  match: string
  /**
   * Match `match` as the one literal subject: the same path, URL, query, or command
   * after the matcher's normal canonicalization, with `*` an ordinary character and no
   * directory or prefix extension. "Always allow" on a file, URL, or search saves its
   * rule this way, so approving one file can't allow a directory or a glob. Absent on
   * older saved rules, which keep their glob meaning.
   */
  exact?: boolean
  /**
   * When the rule was created (epoch ms) and how: from an approval prompt's "Always
   * allow / deny", or by hand in Settings. Bookkeeping only, never read by the
   * matcher; absent on rules saved before it was recorded.
   */
  addedAt?: number
  source?: 'prompt' | 'settings'
}

/**
 * A permission rule's identity for bookkeeping that lives outside the rule itself
 * (when it last decided a call): the fields the matcher reads, NUL-separated.
 */
export function permissionRuleKey(r: Pick<PermissionRule, 'action' | 'tool' | 'match' | 'exact'>): string {
  return `${r.action}\u0000${r.tool || '*'}\u0000${r.match ?? ''}\u0000${r.exact ? 'exact' : ''}`
}

/** The result of testing a call against every permission tier (Settings' rule tester). */
export interface PermissionTestResult {
  /** What the rules decide, or null when none match (the approval mode decides). */
  decision: PermissionRule['action'] | null
  /** Which tier decided, or null when none matched. */
  tier: 'managed' | 'project' | 'user' | 'project-allow' | null
  /** Indices of the user's rules that each match this call on their own. */
  userMatches: number[]
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

/**
 * A command from the native File menu, run by the renderer with the same handlers
 * the command palette and sidebar use. `new-chat-in-workspace` (File → Open Recent)
 * carries a folder main has already checked against the recents list.
 */
export type MenuCommand =
  | { type: 'new-chat' }
  | { type: 'new-chat-in-folder' }
  | { type: 'new-chat-in-workspace'; workspace: string }
  | { type: 'import-chat' }
  | { type: 'export-chat'; format: 'json' | 'html' }
  /** Help → Take the Tour…: replay the getting-started tips. */
  | { type: 'take-tour' }

/** Renderer UI state the native menu reflects (Export is greyed out with no chat open). */
export interface MenuState {
  hasConversation: boolean
}

export interface AppSettings {
  schemaVersion: number
  providers: ProviderConfig[]
  selected: SelectedModel | null
  /**
   * Next-choice models, tried in order when `selected` can't serve a turn — the
   * provider is overloaded or rate-limiting past the retry budget, or the request
   * doesn't fit the model's context window even after compaction.
   *
   * A hop never splices two models' output: anything the failing model had streamed
   * is retracted first (`turn_discarded`). Entries may name any provider; one that no longer
   * resolves (removed provider, missing key) is skipped rather than failing the run.
   * Unset or empty means a failing model ends the turn, as before.
   */
  fallbackModels?: SelectedModel[]
  approvalPolicy: ApprovalPolicy
  recentWorkspaces: string[]
  /**
   * Realpath-normalized workspace paths the user has opted out of the first-write
   * "Initialize git repository" prompt for ("Don't ask again for this folder").
   * Checked before showing the banner; appended to on opt-out.
   */
  gitInitDismissed?: string[]
  /**
   * Per-folder decisions on honoring project elevating config (`allow` rules,
   * hooks, MCP servers from `.houston/settings.json`) — see {@link FolderTrust}.
   * Lives in the user's own settings, never in the project file it governs.
   */
  trustedFolders?: FolderTrust[]
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
   * How full auto treats web reads (`web_fetch` and `web_search`). `ask` (default):
   * once per site, and once for search, per chat. `allow`: without asking. A URL or
   * query carrying a credential is refused either way. Other policies always ask.
   */
  webReads?: 'ask' | 'allow'
  /**
   * Per-provider "an API key is stored" flags, keyed by search-provider id. Derived
   * from the secrets store on every read, never persisted.
   */
  searchKeyStatus?: Record<string, boolean>
  /** How hard the model should think before answering (default DEFAULT_REASONING_EFFORT). */
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
   * Check a file right after the agent writes it and feed the problems the edit
   * introduced back so the model can self-correct in the same turn. Read-only (never
   * modifies the file).
   *  - unset (default): the language server covering the file reports new errors (and
   *    a few warnings); files no installed server covers get no check.
   *  - true: the same, plus a fast checker (eslint/ruff/pyflakes/gofmt) for files no
   *    language server covers, when its binary is installed.
   *  - false: no post-edit checks.
   */
  diagnosticsOnSave?: boolean
  /**
   * Language servers (code intelligence: post-edit diagnostics and the lsp_* tools).
   * Unset: on when the OS sandbox can confine them. true: on even where it can't.
   * false: off. Servers are never bundled; one runs only when its binary is installed.
   */
  lspEnabled?: boolean
  /** Extra language servers, or replacements for a built-in one (same `id`). */
  lspServers?: LspServerConfig[]
  /**
   * Hard cap on loop iterations for a single agent turn. When the run gets within
   * a small margin of this cap it's nudged to "land" (finish or summarize) rather
   * than being cut off mid-edit. Falls back to DEFAULT_BUDGET_LIMITS.maxIterations
   * when unset; clamped to at least 1.
   */
  maxIterations?: number
  /**
   * Let a turn that is still making progress (successful file edits in several of
   * its recent steps, or new reads/commands in most of them, and no stall) run past
   * `maxIterations` in `maxIterations`-sized chunks instead of being told to wrap up.
   * Unset: on, unless `maxIterations` is set (an explicit cap stays a hard stop until
   * opted in). See autoExtendTurnsEnabled.
   */
  autoExtendTurns?: boolean
  /**
   * Absolute step cap for an auto-extended turn. Defaults to
   * DEFAULT_ITERATION_CEILING; a value at or below `maxIterations` disables extension.
   */
  maxIterationsCeiling?: number
  /**
   * How much subagent activity (steps, result previews, diffs) a chat keeps, in MB.
   * Past it, the oldest subagents keep their task, step list and report but drop step
   * outputs and diffs. Unset: DEFAULT_SUBAGENT_HISTORY_MB. 0 keeps summaries only.
   */
  subagentHistoryMb?: number
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
  /**
   * Run interactive HTML visuals (```html visual blocks, and Preview on plain HTML
   * blocks) in sandboxed frames in the chat. Off by default: diagrams and SVG render
   * either way, but running model-written HTML is opt-in.
   */
  htmlVisuals?: boolean
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
   * Egress policy for network-granted sandbox commands (see @shared/egress).
   * Absent = allowlist mode: granted network is confined to the built-in
   * dev-infrastructure allowlist (package registries, VCS hosts) plus the user's
   * `allow` entries, enforced by a loopback proxy where the OS sandbox can
   * confine egress. `mode: 'all'` is the explicit unrestricted escape hatch.
   */
  sandboxEgress?: SandboxEgressSettings
  /**
   * Show a native desktop notification when the agent finishes, needs approval,
   * asks a question, or opens/merges a pull request while Houston isn't the
   * focused window. On by default.
   */
  desktopNotifications?: boolean
  /**
   * Show a count on the app icon (the macOS Dock badge, the Linux launcher count, a
   * dot on the Windows taskbar button) of chats that need input, failed, or have
   * unread replies. On by default.
   */
  appBadge?: boolean
  /** UI color theme (default follows the OS). */
  theme?: 'system' | 'dark' | 'light'
  /**
   * The interactive terminal's color theme. Separate from `theme` above, which is
   * the desktop app's light/dark preference: the terminal's palettes are ANSI
   * choices (which foregrounds are readable on this background, or which colors a
   * colorblind reader can tell apart), not a UI appearance mode.
   */
  tuiTheme?: string
  /**
   * Which keys the terminal composer answers to. 'emacs' (the default) is the
   * readline-style set every shell gives you; 'vim' adds modal editing on top of
   * it. Absent = emacs.
   */
  tuiEditor?: 'emacs' | 'vim'
  /** User-defined sidebar groups, in display order. */
  chatGroups?: ChatGroup[]
  /**
   * Collapsed state for the sidebar's built-in sections, keyed by section id
   * ('pinned', 'ungrouped'). Custom groups keep their own collapsed flag on the
   * group; these two aren't groups, so their state lives here. Absent = expanded.
   */
  collapsedSections?: Record<string, boolean>
  /**
   * Chats whose spawned sessions are folded away in the sidebar (by chat id).
   * Absent = every parent expanded. Ids of deleted chats are pruned on the next fold.
   */
  collapsedSpawnParents?: string[]
  /**
   * Sort chats that want attention (needs input, failed, unread) to the top of each
   * sidebar section. Absent = off (the usual recency / manual order).
   */
  sidebarUnreadFirst?: boolean
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
   * First-run onboarding progress: the get-started checklist, which coachmarks have
   * been seen, and the one-time tour invitation for pre-onboarding installs. See
   * @shared/onboarding. Absent on a fresh install.
   */
  onboarding?: OnboardingState
}

/** One format-on-save backend and whether its binary is present on this machine. */
/** A user-configured language server (Settings > Tools). */
export interface LspServerConfig {
  /** Name for the server; reusing a built-in id (typescript, python, go, rust, clangd) replaces it. */
  id: string
  /** Executable name on PATH, or an absolute path. */
  command: string
  args?: string[]
  /** File extensions it covers, without the dot (e.g. `["lua"]`). */
  extensions: string[]
  /** The LSP languageId to open those files with (defaults to the extension). */
  languageId?: string
  /** Files whose presence at the project root means the project uses this language. */
  rootMarkers?: string[]
  initializationOptions?: unknown
}

/** One language server's install status, for Settings and /doctor. */
export interface LanguageServerStatus {
  id: string
  name: string
  /** File extensions it covers. */
  languages: string[]
  /** Resolved executable, or null when not installed. */
  path: string | null
  /** Where it was found: the workspace's node_modules/.bin, PATH, or a settings entry. */
  source?: 'workspace' | 'path' | 'settings'
  installHint: string
  /** Configured in settings rather than built in. */
  user: boolean
}

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
  /**
   * True when formatters can't run on this host whatever is installed: Windows without
   * Git for Windows, where the shell is the cmd.exe fallback.
   */
  formattersNeedGitBash?: boolean
  /** Language servers Houston can drive, and which are installed. */
  languageServers?: LanguageServerStatus[]
  /**
   * Why language servers won't start on this host even when installed, if they won't:
   * 'disabled' (turned off in settings), 'unsandboxed' (no OS sandbox to confine them
   * and not turned on explicitly), or 'needs-git-bash' (Windows without Git Bash).
   */
  languageServersBlocked?: 'disabled' | 'unsandboxed' | 'needs-git-bash'
}

/** The user's answer to the one-time "global rules moved" notice. */
export type LegacyRulesChoice = 'import' | 'keep'

/** Result of answering that notice. `error` is set (and nothing is persisted) when the import write failed. */
export interface LegacyRulesDecideResult {
  settings: AppSettings
  /** The global rules file written, after a successful import. */
  file?: string
  error?: string
}
