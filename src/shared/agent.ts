/**
 * Provider-agnostic chat + tool-calling types. Each provider adapter translates
 * to/from these so the agent loop and UI never depend on a specific SDK shape.
 */

import type { FileDiffPreview } from './diff'

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

/** A JSON Schema object describing a tool's parameters. */
export type JSONSchema = Record<string, unknown>

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

/**
 * How hard the model should "think" before answering. `off` disables it.
 * `xhigh` is the maximum tier (OpenAI Responses on newer flagships); providers
 * without an xhigh tier clamp it to `high`.
 */
export const REASONING_EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh'] as const

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

/** Runtime guard for an effort arriving from a command line / IPC. */
export function isReasoningEffort(v: unknown): v is ReasoningEffort {
  return typeof v === 'string' && (REASONING_EFFORTS as readonly string[]).includes(v)
}

/** How the model's reasoning summary is requested (OpenAI Responses API). */
export type ReasoningSummary = 'auto' | 'concise' | 'detailed' | 'none'

/** Response detail/length knob, distinct from reasoning effort (OpenAI Responses). */
export type Verbosity = 'low' | 'medium' | 'high'

/**
 * A block of model reasoning ("extended thinking"). For Anthropic these must be
 * preserved verbatim — including their cryptographic `signature` — and replayed
 * on the next request when the turn used tools, or the API rejects the turn.
 * `redactedData` carries an encrypted (redacted) thinking block instead of text.
 */
/**
 * A block of model reasoning captured from a completed turn, replayed on the next
 * request so the model keeps its chain of thought across tool calls. The fields are
 * provider-specific and mutually exclusive in practice:
 *
 *  - Anthropic: `signature` authenticates a replayed `thinking` block; `redactedData`
 *    carries an opaque `redacted_thinking` payload.
 *  - OpenAI Responses: `id` + `encryptedContent` carry the reasoning item's state.
 *
 * `text` is the human-readable reasoning (Anthropic) or summary (OpenAI), and is what
 * the UI renders. It is never sufficient on its own to replay state — a provider that
 * has only `text` for a block must drop it rather than send an unauthenticated one.
 */
export interface ReasoningBlock {
  text: string
  signature?: string
  redactedData?: string
  /**
   * The model that produced this block. Reasoning state is model-bound — an
   * Anthropic signature and an OpenAI `encrypted_content` only mean anything to
   * the model that issued them — so an adapter replays a block only when it
   * matches the request's model, and drops it after a fallback hop or a manual
   * model switch. Absent on blocks persisted before this was recorded; those are
   * replayed as before rather than silently dropped.
   */
  model?: string
  /** OpenAI Responses: the reasoning item's id (`rs_...`). */
  id?: string
  /**
   * OpenAI Responses: the encrypted reasoning state, returned only when the request
   * asked for `include: ['reasoning.encrypted_content']`. This is the whole payload —
   * an `id` without it is a dangling reference to a response we never stored.
   */
  encryptedContent?: string
}

/** A non-image document (e.g. a PDF) attached to a message, base64-encoded. */
export interface DocumentAttachment {
  mediaType: string
  data: string
  name?: string
}

export interface ChatMessage {
  role: ChatRole
  content: string
  /** Present on `user` turns with image attachments, or `tool` turns that read an image. */
  images?: ImageAttachment[]
  /** Present on `tool` turns that read a document (e.g. a PDF). */
  documents?: DocumentAttachment[]
  /** Present on assistant turns that call tools. */
  toolCalls?: ToolCall[]
  /** Present on assistant turns produced with reasoning enabled. */
  reasoning?: ReasoningBlock[]
  /** Present on `tool` turns — the id of the call this result answers. */
  toolCallId?: string
  /** Present on `tool` turns — the name of the tool that produced this result. */
  toolName?: string
}

/**
 * Prefix on the synthetic `user` message that stands in for a compacted head (see
 * `buildSummaryMessages`). Lives here in shared so the renderer can recognize the
 * summary turn and render its markdown body, without reaching into main-process code.
 */
export const COMPACTION_SUMMARY_PREFIX =
  'Summary of the earlier conversation (older messages were compacted to save context):'

/**
 * Prefix on an automated guidance turn the loop injects on the model's behalf (a
 * stall nudge, the budget "landing" reminder). It has to ride on a `user` message
 * because providers drop a mid-conversation `system` role (Anthropic passes system
 * out-of-band), but the prefix makes clear to the model that it's an automated
 * system note, not something the user typed — and lets the renderer show it as a
 * system notice rather than a user bubble (and skip it as the "last user message").
 */
export const SYSTEM_NOTE_PREFIX = 'Automated note from Houston (not from the user):'

export interface ToolSchema {
  name: string
  description: string
  parameters: JSONSchema
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'error' | 'aborted'

export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
  /**
   * Portion of `inputTokens` served from the provider's prompt cache (Anthropic's
   * `cache_read_input_tokens`). Still counted in `inputTokens` (it's real context
   * that fills the window), but it bills far below the base input rate, so the cost
   * estimate prices it separately. Absent for providers that don't report a split.
   */
  cacheReadTokens?: number
  /**
   * Portion of `inputTokens` that wrote a new prompt-cache entry (Anthropic's
   * `cache_creation_input_tokens`). Bills slightly *above* the base input rate.
   */
  cacheWriteTokens?: number
}

/** A single event in a streamed provider response. */
export type ProviderStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'done'; stopReason: StopReason; usage?: TokenUsage; reasoning?: ReasoningBlock[] }
  | {
      type: 'error'
      message: string
      /**
       * The HTTP status this failure corresponds to, when the adapter can tell. An
       * in-band error has none on the wire — the response was already a 200 when the
       * stream broke — so the adapter derives it (e.g. from the API's error `code`).
       * Consumers rethrow via `providerStreamError` to keep it attached, which is what
       * lets the retry classifier treat this like a thrown SDK error instead of
       * guessing from the message text. Absent when the adapter can't tell, which
       * (correctly) reads as non-retryable.
       */
      status?: number
      /** The server's requested wait before a retry, in ms, when it named one. */
      retryAfterMs?: number
    }

export interface ChatRequest {
  model: string
  system?: string
  messages: ChatMessage[]
  tools?: ToolSchema[]
  maxTokens?: number
  /** Enable model reasoning at this effort (omit/`off` to disable). */
  reasoningEffort?: ReasoningEffort
  /**
   * Whether the selected model supports reasoning, from the host's capability
   * metadata (`ModelOption.caps.reasoning`). Overrides the adapter's name-based
   * heuristic per-field: `true` forces reasoning on for a host-routed model the
   * id-regex wouldn't recognize (e.g. `deepseek/deepseek-r1`); `false` forces it
   * off; `undefined` falls back to the heuristic.
   */
  reasoningCapable?: boolean
  /** How to request the reasoning summary (OpenAI Responses; `none` = no summary). */
  reasoningSummary?: ReasoningSummary
  /** Response verbosity (OpenAI Responses). */
  verbosity?: Verbosity
  /**
   * Send Anthropic-style `cache_control` breakpoints on an OpenAI-compatible
   * request, opting an explicit-caching upstream (Claude/Qwen/Gemini routed via
   * an aggregator host) into prompt caching. Set only when the route is gated as
   * cache-capable (see `providers/caching.ts`); plain OpenAI-compatible servers
   * must never receive the nonstandard field. Ignored by the other adapters
   * (native Anthropic always sends its own breakpoints).
   */
  explicitCacheControl?: boolean
  signal?: AbortSignal
}

export interface Provider {
  streamChat(req: ChatRequest): AsyncGenerator<ProviderStreamEvent>
}

// ---- Agent run protocol (main <-> renderer) ----

import type { ApprovalPolicy } from './types'
import type { ImageAttachment } from './images'

/**
 * A git worktree Houston created to back a conversation. Lets a chat work on its
 * own branch in an isolated checkout — and lets the app surface the branch in the
 * UI and clean the worktree up when the chat is deleted. `path` is the worktree's
 * working directory (also the conversation's `workspace`); `repoRoot` is the main
 * worktree the branch was created from.
 */
export interface ConversationWorktree {
  /** Absolute path of the worktree's working directory (equals `workspace`). */
  path: string
  /** Branch created and checked out in the worktree. */
  branch: string
  /** Absolute path of the repo's main worktree the branch was created from. */
  repoRoot: string
}

/** A git repo as seen from one of its worktrees, used to drive the new-chat UI. */
export interface RepoInfo {
  /** False when the path isn't inside a git repo (no worktree options offered). */
  isRepo: boolean
  /** Absolute path of the main worktree (where new worktrees are nested). */
  root: string
  /** Branch currently checked out at the queried path (null if detached). */
  currentBranch: string | null
  /** Local branch names, newest-committed first, for picking a base. */
  branches: string[]
  /**
   * True when the queried path is itself the root of a linked (non-main)
   * worktree — e.g. a per-chat checkout inherited from a previously-open chat.
   * False for the main root, for any subdirectory, and for non-repos, so the
   * new-chat UI can re-anchor only genuine worktree roots and honor a
   * deliberately-picked subdirectory.
   */
  isLinkedWorktreeRoot: boolean
  /**
   * Whether the queried path still exists on disk. Distinguishes a valid
   * non-repo folder (`exists: true, isRepo: false`) from a path that has since
   * been deleted — e.g. a torn-down worktree left behind in the recents — so the
   * new-chat UI can drop the stale default instead of anchoring to a phantom.
   */
  exists: boolean
}

/** Outcome of tearing down a conversation's worktree, for reporting to the user. */
export interface WorktreeRemoval {
  /** Whether the worktree directory was removed from git and disk. */
  removed: boolean
  /** Whether the branch was deleted (only when fully merged, unless forced). */
  branchDeleted: boolean
  /** Human-readable note when something was left in place. */
  message?: string
}

/** Outcome of a delete-conversation request, after the confirmation prompt. */
export interface DeleteConversationResult {
  /** False when the user cancelled the confirmation — nothing was deleted. */
  deleted: boolean
  /** What happened to the worktree, when one was torn down. */
  worktree?: WorktreeRemoval | null
}

export interface ConversationMeta {
  id: string
  title: string
  workspace: string
  providerId: string
  model: string
  createdAt: number
  updatedAt: number
  /** Pinned chats float to a "Pinned" section at the top of the sidebar. */
  pinned?: boolean
  /**
   * Archived chats are hidden from the default "Active" sidebar view and only
   * shown when the status filter is switched to "Archived". Group membership is
   * preserved, so an archived chat rejoins its group when unarchived.
   */
  archived?: boolean
  /** Id of the custom group (see AppSettings.chatGroups) this chat belongs to. */
  groupId?: string
  /**
   * Manual sort position within its sidebar section (group / ungrouped), set by
   * drag-to-reorder. Lower sorts higher. Absent until the user reorders that
   * section, in which case the chat falls back to recency ordering. The value is
   * only meaningful within one section, so it is cleared whenever the chat
   * changes section (pin / archive / group move).
   */
  order?: number
  /** Set once the user explicitly renames the chat — auto-titling never overwrites it. */
  titleCustom?: boolean
  /** Set once a model-summarized title has been produced, so it's generated at most once. */
  titleGenerated?: boolean
  /** Present when this chat runs in a git worktree Houston created for it. */
  worktree?: ConversationWorktree
  /**
   * Present when this chat was created by another chat's `spawn_session` tool —
   * carries the spawning chat's id and its title at spawn time, so the spawned
   * chat can show a "handoff from …" label above its seeded first message.
   */
  spawnedFrom?: { conversationId: string; title: string }
  /**
   * True when the most recent run ended in an error (mirrors {@link Conversation.lastError}
   * without carrying the message). Surfaced in the lightweight list so the background-tasks
   * indicator can mark a finished run as failed without loading the full conversation.
   */
  errored?: boolean
}

/**
 * A background shell started by `run_shell` with `background: true`, surfaced to
 * the renderer for the background-tasks indicator. Mirrors the main-process
 * registry entry minus the live child handle and output buffers.
 */
export interface BackgroundShellInfo {
  id: string
  /** The command line, used as the task title. */
  command: string
  running: boolean
  /** Exit status once finished; null while running or if it was killed. */
  exitCode: number | null
  /** Epoch ms the shell was spawned. */
  startedAt: number
  /** Epoch ms it exited, or null while still running. */
  exitedAt: number | null
  /** Conversation whose agent run spawned this shell, for click-to-open navigation. */
  conversationId?: string
}

/** Token usage persisted with a conversation so it survives reloads/restarts. */
export interface ConversationUsage {
  /** Input tokens of the most recent turn — i.e. the current context size. */
  inputTokens: number
  /** Output tokens summed across every turn ever run in this conversation. */
  outputTokens: number
  /** Estimated cumulative USD cost across every turn (0 when the model has no known price). */
  cost: number
}

/**
 * The error that ended a conversation's most recent run, persisted so the "last
 * turn failed" state — and its Retry affordance — survive a reload or restart. Set
 * only when a run ends in an error (never on a natural or aborted end) and cleared
 * when the next run starts, so it never lingers as a stale failure.
 */
export interface ConversationError {
  message: string
}

/**
 * Version stamped into every persisted conversation file, mirroring
 * SETTINGS_SCHEMA_VERSION for settings. Bump it alongside a version-gated step in
 * the conversation store's migrate() whenever the on-disk format changes, so old
 * files are upgraded on load instead of surfacing as runtime breakage. Files
 * written before versioning existed carry no `schemaVersion` and are treated as
 * version 0 (shape-identical to v1).
 */
export const CONVERSATION_SCHEMA_VERSION = 1

/**
 * Context-compaction state persisted with a conversation, so the next run resumes
 * from the last summary instead of re-summarizing the same head on every turn.
 * `cut` indexes into `messages`: the turns before it are represented by `summary`
 * (rendered as the synthetic summary pair the loop sends), and `messages[cut..]`
 * go to the provider verbatim. Written only with `cut` on a `user`-message
 * boundary; readers must validate against the current log before applying it
 * (see `isValidCompactionState`) and fall back to re-summarizing when it's stale
 * — e.g. after `/compact` rewrote the log, or on a hand-edited file.
 */
export interface ConversationCompaction {
  /** Index into `messages` where the verbatim tail begins (a `user` boundary). */
  cut: number
  /** Summary text standing in for `messages[0..cut)` in the provider window. */
  summary: string
}

export interface Conversation extends ConversationMeta {
  /** Absent only in legacy (pre-versioning) files on disk; stamped on every write. */
  schemaVersion?: number
  messages: ChatMessage[]
  usage?: ConversationUsage
  /** Present when the most recent run failed; powers the persisted Retry banner. */
  lastError?: ConversationError
  /** Present once the loop has compacted this chat; see {@link ConversationCompaction}. */
  compaction?: ConversationCompaction
}

/** Internal input to the agent loop. */
export interface AgentRunRequest {
  runId: string
  /**
   * The conversation this run belongs to, when started from the UI. Used to keep
   * at most one live run per conversation (two would interleave their persisted
   * `setMessages` writes and corrupt the log). Omitted for one-shot headless runs,
   * which have no conversation and can't collide.
   */
  conversationId?: string
  workspace: string
  providerId: string
  model: string
  approvalPolicy: ApprovalPolicy
  messages: ChatMessage[]
}

/** What the renderer sends to start a turn in a conversation. */
export interface AgentSendRequest {
  runId: string
  conversationId: string
  userText: string
  images?: ImageAttachment[]
  providerId: string
  model: string
  approvalPolicy: ApprovalPolicy
}

/**
 * The user's verdict on a tool-approval prompt:
 * - `allow`      — run this one call.
 * - `deny`       — refuse this one call.
 * - `always`     — "Allow for run": auto-approve this tool KIND for the rest of the
 *                  conversation (in-memory; see agent/overrides.ts).
 * - `rule-allow` — "Always allow": persist an `allow` permission rule for this call's
 *                  tool + subject (survives restarts), then run it.
 * - `rule-deny`  — "Always deny": persist a `deny` permission rule, then refuse it.
 */
export const TOOL_APPROVAL_DECISIONS = ['allow', 'deny', 'always', 'rule-allow', 'rule-deny'] as const

export type ToolApprovalDecision = (typeof TOOL_APPROVAL_DECISIONS)[number]

/** Runtime guard for a value arriving over IPC — reject anything off the list. */
export function isToolApprovalDecision(v: unknown): v is ToolApprovalDecision {
  return typeof v === 'string' && (TOOL_APPROVAL_DECISIONS as readonly string[]).includes(v)
}

/**
 * How much guidance a denial may carry back to the model. Long enough for a real
 * instruction ("use the staging bucket, not prod"), short enough that a runaway
 * paste can't be smuggled into the transcript through the approval channel.
 */
export const MAX_APPROVAL_NOTE = 2000

/**
 * Longest course correction accepted mid-turn (see `steerRun`), and how many may
 * wait for the next iteration boundary at once.
 *
 * Same bound, and the same reason, as {@link MAX_APPROVAL_NOTE}: both are a
 * sentence of guidance the user pushes into a RUNNING turn's window, and neither
 * should be able to flood it. The count matters as much as the length — steers are
 * held until the loop reaches a boundary, and a turn stuck in a long tool call
 * could otherwise collect them without limit.
 */
export const MAX_STEER_TEXT = 2000
export const MAX_PENDING_STEERS = 20

/**
 * The user's verdict plus, optionally, why — "no, and here's what to do instead".
 *
 * Without the note a denial is a dead end: the model is told only that it was
 * refused, so it retries a variant, guesses, or gives up, and the user has to
 * interrupt and re-explain in a separate turn. The note rides the SAME
 * interaction, so the correction lands where the refusal did.
 *
 * Carried on every decision (not just `deny`): "allow, but prefer X next time" is
 * as useful as a refusal, and `rule-deny` wants the reason recorded too.
 */
export interface ApprovalResolution {
  decision: ToolApprovalDecision
  /** Free-text guidance shown to the model with the tool result. Trimmed + capped. */
  note?: string
}

/** Clamp user-supplied guidance to something safe to put in the transcript. */
export function sanitizeApprovalNote(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const trimmed = v.trim().slice(0, MAX_APPROVAL_NOTE)
  return trimmed || undefined
}

/**
 * A finished implementation plan the agent presents in Plan mode via the
 * `present_plan` tool. Rendered in full in the docked plan-review panel.
 *
 * `body` is the primary content: the whole plan as freeform markdown, authored
 * however the model sees fit (overview, rationale, steps, code, tables). `overview`
 * and `steps` are the older structured form, kept so plans persisted before the
 * freeform field still render; the panel prefers `body` and falls back to them.
 */
export interface PlanPayload {
  /** Short title for the plan (a few words). */
  title: string
  /** The full plan as freeform markdown — the panel renders this as-is. */
  body?: string
  /** Legacy: one or two sentences summarizing the change (pre-`body` plans). */
  overview?: string
  /** Legacy: the ordered steps to carry out the change (pre-`body` plans). */
  steps?: string[]
  /** Repo-relative paths the plan will create or change, if given. */
  files?: string[]
}

/** How edits should run after the user accepts a plan (drives the policy switch). */
export type PlanAcceptMode = 'auto-edit' | 'ask'

/**
 * The user's verdict on a presented plan:
 * - `accept`  — carry it out; switch off Plan mode to `mode` (`auto-edit` applies
 *               edits automatically, `ask` prompts on each one). `editedBody`, when
 *               present, is the user's manually-edited plan markdown — the agent is
 *               told to carry out exactly that instead of the plan it presented.
 * - `suggest` — keep planning; send `note` back so the agent revises the plan.
 * - `reject`  — discard this plan; stay in Plan mode and wait for direction.
 */
export type PlanDecision =
  | { kind: 'accept'; mode: PlanAcceptMode; editedBody?: string }
  | { kind: 'suggest'; note: string }
  | { kind: 'reject' }

/** Runtime guard for a plan decision arriving over IPC — reject anything malformed. */
export function isPlanDecision(v: unknown): v is PlanDecision {
  if (!v || typeof v !== 'object') return false
  const d = v as Record<string, unknown>
  if (d.kind === 'accept') {
    return (
      (d.mode === 'auto-edit' || d.mode === 'ask') &&
      (d.editedBody === undefined || typeof d.editedBody === 'string')
    )
  }
  if (d.kind === 'suggest') return typeof d.note === 'string'
  if (d.kind === 'reject') return true
  return false
}

/** One suggested answer to an `ask_user` question. */
export interface QuestionOption {
  /** Short text the user selects. */
  label: string
  /** Optional one-line explanation of what this option means. */
  description?: string
}

/** A structured question the agent asks the user via the `ask_user` tool. */
export interface AgentQuestion {
  question: string
  options: QuestionOption[]
  /** Allow selecting more than one option (default false). */
  multiSelect?: boolean
}

/**
 * One field an MCP server asks for in an elicitation request. The MCP spec
 * restricts `requestedSchema` to a flat object of primitives, so a field is
 * always one of these kinds; anything exotic degrades to a plain string input.
 */
export interface ElicitationField {
  name: string
  kind: 'string' | 'number' | 'integer' | 'boolean' | 'enum'
  /** Display label, when the schema gave one (falls back to `name`). */
  title?: string
  description?: string
  required?: boolean
  /** Allowed values, for kind 'enum'. */
  options?: string[]
  /** Schema `format` hint (email, uri, date, date-time), pass-through for the UI. */
  format?: string
}

/** The user's (or client's) answer to an MCP elicitation request. */
export interface ElicitationResult {
  action: 'accept' | 'decline' | 'cancel'
  /** Field values, present only on accept. */
  content?: Record<string, string | number | boolean>
}

/**
 * Boundary guard for an elicitation result arriving over IPC: reject malformed
 * shapes, keep only primitive values, and cap string lengths and field count so
 * a compromised renderer can't smuggle an oversized or structured payload to an
 * external MCP server. Returns null when the shape is not an elicitation result.
 */
export function sanitizeElicitationResult(v: unknown, maxValueLen = 4000): ElicitationResult | null {
  if (!v || typeof v !== 'object') return null
  const { action, content } = v as { action?: unknown; content?: unknown }
  if (action !== 'accept' && action !== 'decline' && action !== 'cancel') return null
  if (action !== 'accept') return { action }
  const out: Record<string, string | number | boolean> = {}
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    for (const [k, val] of Object.entries(content as Record<string, unknown>).slice(0, 50)) {
      if (typeof val === 'string') out[k] = val.slice(0, maxValueLen)
      else if (typeof val === 'number' && Number.isFinite(val)) out[k] = val
      else if (typeof val === 'boolean') out[k] = val
    }
  }
  return { action: 'accept', content: out }
}

/** Events streamed from a running agent to the renderer. */
export type AgentEvent =
  | { runId: string; type: 'text'; delta: string }
  | { runId: string; type: 'reasoning'; delta: string }
  /**
   * A course correction the user typed while the turn was running, now in the
   * model's window (see `steerRun`). Emitted at the iteration boundary where it
   * actually lands, not when it was typed, so the transcript shows it in the order
   * the model read it rather than the order it was received.
   */
  | { runId: string; type: 'steered'; text: string }
  | {
      runId: string
      type: 'tool_start'
      callId: string
      name: string
      args: Record<string, unknown>
      /**
       * The tool's kind, so the transcript can tag every tool row (e.g. to notice a
       * write landed) — not just the ones that went through an approval prompt. Optional
       * for back-compat with events constructed without it (older logs / tests).
       */
      kind?: 'read' | 'write' | 'shell' | 'network' | 'mcp'
      /**
       * Per-file diffs this call is about to produce, captured against the files'
       * current contents (see `previewWrite`). Carried here as well as on
       * `tool_approval` so an auto-approved write — one that never showed a prompt —
       * still has a true diff on its row, and so the row keeps showing it after the
       * write has landed and the "before" is gone from disk.
       */
      preview?: FileDiffPreview[]
    }
  | { runId: string; type: 'tool_progress'; callId: string; message: string }
  | {
      // A nested subagent spawned by a tool (e.g. one of review_changes' per-dimension
      // reviewers), surfaced as its own live row under the parent tool's row. Emitted
      // when the subagent starts and again when it finishes, keyed by a stable `id`
      // within the parent so the row updates in place.
      runId: string
      type: 'subagent'
      /** The tool call (e.g. a review_changes call) that spawned this subagent. */
      parentCallId: string
      /** Stable id of this subagent row within its parent (e.g. the review dimension). */
      id: string
      /** Human label for the row (e.g. "Correctness", "Verifying findings"). */
      label: string
      status: 'running' | 'done' | 'error'
    }
  | {
      runId: string
      type: 'tool_approval'
      callId: string
      name: string
      summary: string
      /**
       * The tool's arguments, so the approval card can render the same command/target
       * it shows once the call runs. Without this the renderer has no args until
       * `tool_start` (emitted only AFTER approval), so the prompt would show its verb
       * with a blank command and the user couldn't see what they were approving. The
       * live run always sets it; optional only so events built without it (tests) type.
       */
      args?: Record<string, unknown>
      kind: 'read' | 'write' | 'shell' | 'network' | 'mcp'
      /**
       * Per-file diffs this call would produce, computed against the files' current
       * contents before it runs. Set for write-kind calls whose effect can be modelled
       * (see `previewWrite`); absent otherwise. The renderer cannot derive this from
       * `args` alone — it has no filesystem, so it cannot know what a file already
       * holds, nor run the edit matcher that decides what an edit resolves to.
       */
      preview?: FileDiffPreview[]
      /**
       * Present and `false` only when this is a shell command about to run WITHOUT an
       * OS sandbox (no enforceable confinement on this host) — lets the approval UI warn
       * that the command runs unconfined. Absent on confining hosts (e.g. macOS).
       */
      sandboxed?: boolean
      /**
       * Present and `true` only on the one-time full-auto shell-network consent: the
       * decision governs whether the sandbox lets shell commands reach the network for
       * the rest of the run, NOT whether this command runs (it runs either way — a
       * decline just runs it offline). Lets the UI frame the prompt as a network grant.
       */
      shellNetwork?: boolean
    }
  | {
      runId: string
      type: 'tool_result'
      callId: string
      name: string
      ok: boolean
      output: string
      /** Images the tool produced (e.g. a view_localhost screenshot), shown in the transcript. */
      images?: ImageAttachment[]
    }
  | {
      runId: string
      type: 'tool_question'
      callId: string
      question: string
      options: QuestionOption[]
      multiSelect?: boolean
    }
  | {
      // The agent presented a finished plan via `present_plan` and is now blocked
      // awaiting the user's decision (accept / suggest changes / reject). Opens the
      // docked plan-review panel. Replayed on re-adopt like approvals/questions.
      runId: string
      type: 'plan_ready'
      callId: string
      plan: PlanPayload
    }
  | {
      // An MCP server asked the user for input mid-tool-call (MCP elicitation).
      // The run blocks until resolved: accept (with the field values), decline, or
      // cancel. Keyed by its own `elicitId` — one tool call can elicit repeatedly —
      // with `callId` anchoring it under the in-flight tool row. Replayed on
      // re-adopt like approvals/questions.
      runId: string
      type: 'elicitation'
      callId: string
      elicitId: string
      /** The MCP server id asking (shown so the user knows who gets the answer). */
      serverId: string
      message: string
      fields: ElicitationField[]
    }
  | {
      // Emitted by the main process when it auto-starts a follow-up turn from the
      // queued-input buffer (messages typed while the previous turn was running).
      // Carries the conversation so a renderer viewing it can render the user
      // bubble and adopt the run; renderers on other conversations ignore it.
      runId: string
      type: 'turn_start'
      conversationId: string
      userText: string
      images?: ImageAttachment[]
    }
  | { runId: string; type: 'compaction'; summarized: number }
  | { runId: string; type: 'retry'; attempt: number; max: number; message: string }
  | {
      // The turn gave up on one model and moved to the next entry in the user's
      // fallback chain (see `AppSettings.fallbackModels`). Emitted only before any
      // output has streamed, so it always precedes the reply the user actually sees.
      // `from`/`to` are display labels, not ids — the run's model is reported
      // separately via usage/cost.
      runId: string
      type: 'model_fallback'
      from: string
      to: string
      reason: string
    }
  | { runId: string; type: 'limit'; reason: 'max-steps' | 'max-output' | 'stalled' }
  | {
      // The run's end-of-turn verification gate (opt-in) ran the user's configured
      // verification command. `passed` reflects whether it succeeded; a failing
      // pass feeds the output back so the model can self-correct within a bounded
      // number of extra passes. Surfaced as a transcript notice.
      runId: string
      type: 'verification'
      passed: boolean
    }
  | {
      // A note addressed to the user from outside the conversation — today a hook's
      // `systemMessage` directive. Shown as a transcript notice and never added to
      // the model's context (the loop only emits it; it never lands in `messages`).
      runId: string
      type: 'notice'
      message: string
    }
  /**
   * Tokens + cost for one model round.
   *
   * `model` and the cache split were computed to price the round and then thrown
   * away at this seam, which is why /cost could only ever show one aggregate
   * number: you could see what a session cost, but not which model spent it or
   * how much of the input was served from cache (which bills far below the base
   * rate, and is most of a long session's input).
   */
  | {
      runId: string
      type: 'usage'
      inputTokens: number
      outputTokens: number
      cost: number
      /** The model that billed this round; absent on older events. */
      model?: string
      /** Portion of `inputTokens` served from the prompt cache (bills lower). */
      cacheReadTokens?: number
      /** Portion of `inputTokens` that wrote a cache entry (bills slightly higher). */
      cacheWriteTokens?: number
    }
  | { runId: string; type: 'done'; stopReason: StopReason }
  | { runId: string; type: 'error'; message: string }

