import { randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'
import {
  APPROVAL_POLICIES,
  isApprovalPolicy,
  type AppSettings,
  type ApprovalPolicy,
  type McpServerConfig
} from '@shared/types'
import {
  COMPACTION_SUMMARY_PREFIX,
  SYSTEM_NOTE_PREFIX,
  isReasoningEffort,
  sanitizeElicitationResult,
  type AgentEvent,
  type AgentRunRequest,
  type ChatMessage,
  type ElicitationField,
  type ElicitationResult,
  type PlanDecision,
  type PlanPayload,
  type ReasoningEffort,
  type RunLimitReason,
  type ToolApprovalDecision,
  type ConversationSettingsPatch,
  REASONING_EFFORTS,
  retryProgress,
} from '@shared/agent'
import { throttleNotice } from '@shared/rateLimit'
import type { FileDiffPreview } from '@shared/diff'
import { sanitizeAttachments, type ImageAttachment } from '@shared/images'
import { agentTurn, commandTurn, invocationText, type InvokedTurn } from '@shared/promptInvocation'
import { builtinCommands, mergeCommands, parseSlashCommand, resolveCommand, type Command } from '@shared/commands'
import { DEFAULT_REASONING_EFFORT } from '@shared/defaults'
import { modelDisplayName } from '@shared/models'
import { limitNoticeText, runEndNoticeText, runEndRecords } from '@shared/runEnd'
import { parseTodosSafe } from '@shared/todos'
import { resolveContextWindow } from '@shared/usage'
import { formatReceiptLines } from '@shared/evidence'
import { formatReadinessLines } from '@shared/planReadiness'
import { runtimeMissingLine } from '@shared/runtimes'
import { assertNever } from '@shared/assert'
import { SubagentTermLines } from '@shared/subagents'
import { resolveHeadlessModel } from './headless'

/**
 * Agent Client Protocol (ACP) server: the fourth client over the shared agent core,
 * next to the GUI, the TUI, and headless. An ACP-capable editor launches Houston
 * with `--acp` and speaks JSON-RPC 2.0 to it over stdio, one JSON message per line
 * (see agentclientprotocol.com). Houston is the agent side: the editor creates and
 * loads sessions, sends prompts, and renders the `session/update` stream; Houston
 * asks the editor for permission (`session/request_permission`) and, when the editor
 * supports it, for answers (`elicitation/create`).
 *
 * The run itself is the same `startRun` every client uses, so the provider
 * adapters, tools, sandbox, permission rules, and hooks are unchanged. Reads and
 * writes go through Houston's own tools rather than the editor's `fs/*` methods, so
 * workspace containment and the rules keep applying exactly as elsewhere.
 *
 * Like headless.ts, everything here is dependency-injected (no Electron, no real
 * I/O beyond what the caller hands in) so the protocol is testable over an
 * in-memory stream pair; terminalEntry.ts wires the real deps.
 */

/** The ACP protocol version this server speaks. */
export const ACP_PROTOCOL_VERSION = 1

/** JSON-RPC error codes ACP uses. */
export const ACP_ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  authRequired: -32000,
  notFound: -32002
} as const

/** The modes offered on every session: Houston's approval policies, one to one. */
export const ACP_MODES: { id: ApprovalPolicy; name: string; description: string }[] = [
  { id: 'plan', name: 'Plan', description: 'Read-only: explore and propose a plan before changing anything' },
  { id: 'ask', name: 'Ask', description: 'Ask before every edit and command' },
  { id: 'auto-edit', name: 'Auto-edit', description: 'Apply edits automatically, ask before commands' },
  { id: 'full-auto', name: 'Full auto', description: 'Run edits and sandboxed commands without asking' }
]

// The mode list is the policy list; this fails to compile if they drift apart.
const _modesCoverPolicies: (typeof APPROVAL_POLICIES)[number] extends (typeof ACP_MODES)[number]['id'] ? true : never =
  true
void _modesCoverPolicies

/** Answer given to `ask_user` when the editor has no way to ask the user. */
export const ACP_NO_QUESTION_ANSWER =
  '[This editor cannot show a question to the user. Proceed using your best judgment.]'

/** Answer given to `ask_user` when the user dismissed the question. */
export const ACP_DECLINED_ANSWER = '[The user dismissed the question without answering. Proceed using your best judgment.]'

/** Longest tool output carried back to the editor in one update. */
const MAX_TOOL_OUTPUT = 20_000
/** Lines of live progress kept on a tool call. */
const MAX_PROGRESS_LINES = 20
/** Largest file the server reads to show a before/after diff of an edit. */
const MAX_DIFF_FILE_BYTES = 1024 * 1024

// ---- Wire types (the subset of the ACP schema this server sends/reads) ----

type JsonRpcId = number | string

interface JsonRpcMessage {
  jsonrpc?: string
  id?: JsonRpcId | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export class AcpError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message)
  }
}

/** What the editor said it can do on `initialize`. Unknown fields are ignored. */
export interface AcpClientCapabilities {
  fs?: { readTextFile?: boolean; writeTextFile?: boolean }
  terminal?: boolean
  auth?: { terminal?: boolean }
  session?: { notices?: object | null } | null
  elicitation?: { form?: object | null } | null
}

type AcpToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other'
type AcpToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed'
type AcpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
type AcpToolCallContent =
  | { type: 'content'; content: AcpContentBlock }
  | { type: 'diff'; path: string; oldText: string | null; newText: string }

/** An ACP `session/update` payload. */
export type AcpSessionUpdate = Record<string, unknown> & { sessionUpdate: string }

/** The persisted conversation an ACP session is backed by. */
export interface AcpStoredSession {
  id: string
  workspace: string
  messages: ChatMessage[]
  title?: string
  updatedAt?: number
  /** The chat's own model and reasoning effort, which a loaded session keeps. */
  providerId?: string
  model?: string
  reasoningEffort?: ReasoningEffort
  /** The approval mode the user chose for this chat, when they chose one. */
  approvalPolicy?: ApprovalPolicy
}

/** What `/compact` reports back. */
export interface AcpCompactResult {
  ok: boolean
  summarized: number
  error?: string
}

export interface AcpDeps {
  getSettings: () => AppSettings
  startRun: (
    req: AgentRunRequest,
    send: (e: AgentEvent) => void,
    onMessages?: (messages: ChatMessage[]) => void
  ) => Promise<void>
  resolveApproval: (runId: string, callId: string, decision: ToolApprovalDecision, note?: string) => void
  resolveQuestion: (runId: string, callId: string, answer: string) => void
  resolvePlan: (runId: string, callId: string, decision: PlanDecision) => void
  resolveElicitation: (runId: string, elicitId: string, result: ElicitationResult) => void
  cancelRun: (runId: string) => void
  setRunPolicy: (runId: string, policy: ApprovalPolicy) => void
  /** Conversation persistence, shared with the other clients so sessions move between them. */
  store: {
    create: (input: { workspace: string; providerId: string; model: string }) => { id: string }
    get: (id: string) => AcpStoredSession | null
    list: () => Omit<AcpStoredSession, 'messages'>[]
    setMessages: (id: string, messages: ChatMessage[]) => void
    setModel: (id: string, providerId: string, model: string) => void
    /** The chat's current title, read without loading its messages. */
    title?: (id: string) => string | undefined
    /** Save a setting the user changed on this chat (model, reasoning effort, approval mode). */
    setSettings?: (id: string, patch: ConversationSettingsPatch) => void
  }
  /** The workspace's own slash commands (`.houston/commands`), offered next to the built-ins. */
  commands?: (cwd: string) => Promise<Command[]>
  /** The workspace's skills and agents, for `/skills` and `/agents`. */
  skills?: (cwd: string) => Promise<{ name: string; description: string }[]>
  agents?: (cwd: string) => Promise<{ name: string; description: string }[]>
  /** Summarize a stored chat's older turns now (`/compact`). */
  compact?: (conversationId: string, providerId: string, model: string) => Promise<AcpCompactResult>
  /** One protocol frame (a JSON line, newline included). The only thing written to stdout. */
  write: (frame: string) => void
  /** Diagnostics for the operator (stderr / log file), never the protocol stream. */
  log?: (message: string) => void
  /** Default approval policy for new sessions; settings.approvalPolicy when absent. */
  defaultPolicy?: ApprovalPolicy
  version: string
  newId?: () => string
  /** Read a workspace file for an edit's before/after diff; injected so tests stay off disk. */
  readFile?: (path: string) => string | null
}

interface Session {
  id: string
  cwd: string
  providerId: string
  model: string
  mode: ApprovalPolicy
  /** The chat's own reasoning effort, when it has one; otherwise runs use the default. */
  effort?: ReasoningEffort
  /**
   * The conversation so far, or null while it is not held in memory: an idle session
   * past the most recent `ACP_RESIDENT_SESSIONS` drops it and reloads it from the
   * store on its next prompt.
   */
  messages: ChatMessage[] | null
  /** Whether `messages` matches what the store holds, so dropping it loses nothing. */
  saved: boolean
  mcpServers: McpServerConfig[]
  runId: string | null
  cancelled: boolean
  costUsd: number
  /** Last known context fill and window, re-sent with each cost update. */
  context: { used: number; size: number } | null
  /** The chat's title as last sent to the editor. */
  title?: string
  /** A `/compact` in progress, which holds off prompts like a run does. */
  compacting?: boolean
}

// ---- Pure mapping helpers (exported for tests) ----

/** The ACP tool kind for a Houston tool, by name first, then by its permission kind. */
export function acpToolKind(name: string, kind?: 'read' | 'write' | 'shell' | 'network' | 'mcp'): AcpToolKind {
  switch (name) {
    case 'read_file':
    case 'list_dir':
    case 'read_shell_output':
    case 'git_status':
    case 'git_diff':
    case 'recall_history':
      return 'read'
    case 'search_files':
    case 'ast_grep':
    case 'glob':
      return 'search'
    case 'write_file':
    case 'edit_file':
    case 'multi_edit':
    case 'notebook_edit':
    case 'apply_patch':
      return 'edit'
    case 'run_shell':
      return 'execute'
    case 'web_fetch':
    case 'web_search':
      return 'fetch'
    case 'todo_write':
      return 'think'
    case 'present_plan':
      return 'switch_mode'
  }
  switch (kind) {
    case 'read':
      return 'read'
    case 'write':
      return 'edit'
    case 'shell':
      return 'execute'
    case 'network':
      return 'fetch'
    default:
      return 'other'
  }
}

/** The salient argument of a call, for its title ("run_shell: npm test"). */
function argHint(args: Record<string, unknown>): string {
  for (const key of ['path', 'file', 'file_path', 'command', 'cmd', 'query', 'url', 'pattern']) {
    const v = args[key]
    if (typeof v === 'string' && v.trim()) {
      const one = v.replace(/\s+/g, ' ').trim()
      return one.length > 120 ? `${one.slice(0, 119)}…` : one
    }
  }
  return ''
}

export function acpToolTitle(name: string, args: Record<string, unknown>): string {
  const hint = argHint(args)
  return hint ? `${name}: ${hint}` : name
}

/** Absolute file locations a call touches, so the editor can follow along. */
function toolLocations(cwd: string, args: Record<string, unknown>, preview?: FileDiffPreview[]): { path: string }[] {
  const paths = new Set<string>()
  for (const f of preview ?? []) paths.add(resolve(cwd, f.path))
  for (const key of ['path', 'file', 'file_path']) {
    const v = args[key]
    if (typeof v === 'string' && v.trim()) paths.add(resolve(cwd, v))
  }
  return [...paths].map((path) => ({ path }))
}

/**
 * ACP diff content rebuilt from a preview's hunks, for the approval prompt (the
 * write has not happened, so the hunks are all there is). Folded unchanged runs
 * become one marker line on both sides, so the editor shows them as context.
 */
export function previewToDiffContent(cwd: string, preview: FileDiffPreview[]): AcpToolCallContent[] {
  return preview.map((f) => {
    const oldLines: string[] = []
    const newLines: string[] = []
    for (const l of f.diff) {
      if (l.type === 'add') newLines.push(l.text)
      else if (l.type === 'del') oldLines.push(l.text)
      else if (l.type === 'skip') {
        const marker = `⋯ ${l.count ?? ''} unchanged line${l.count === 1 ? '' : 's'}`.replace('  ', ' ')
        oldLines.push(marker)
        newLines.push(marker)
      } else {
        oldLines.push(l.text)
        newLines.push(l.text)
      }
    }
    return {
      type: 'diff' as const,
      path: resolve(cwd, f.path),
      oldText: f.created ? null : oldLines.join('\n'),
      newText: f.deleted ? '' : newLines.join('\n')
    }
  })
}

/** A presented plan as markdown, for the plan-review prompt. */
export function planMarkdown(plan: PlanPayload): string {
  const parts: string[] = [`# ${plan.title}`]
  if (plan.body?.trim()) parts.push(plan.body.trim())
  else {
    if (plan.overview) parts.push(plan.overview)
    if (plan.steps?.length) parts.push(plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'))
  }
  if (plan.files?.length) parts.push(`Files:\n${plan.files.map((f) => `- ${f}`).join('\n')}`)
  if (plan.verify?.length) parts.push(`Checks:\n${plan.verify.map((v) => `- ${v}`).join('\n')}`)
  if (plan.readiness) {
    const lines = formatReadinessLines(plan.readiness)
    if (lines.length) parts.push(lines.join('\n'))
  }
  return parts.join('\n\n')
}

/** An MCP elicitation's fields as the flat JSON Schema `elicitation/create` takes. */
export function elicitationSchema(fields: ElicitationField[]): Record<string, unknown> {
  const properties: Record<string, Record<string, unknown>> = {}
  for (const f of fields) {
    const base: Record<string, unknown> = {
      ...(f.title ? { title: f.title } : {}),
      ...(f.description ? { description: f.description } : {})
    }
    if (f.kind === 'enum') properties[f.name] = { type: 'string', enum: f.options ?? [], ...base }
    else if (f.kind === 'string') {
      const format = ['email', 'uri', 'date', 'date-time'].includes(f.format ?? '') ? { format: f.format } : {}
      properties[f.name] = { type: 'string', ...format, ...base }
    } else properties[f.name] = { type: f.kind, ...base }
  }
  const required = fields.filter((f) => f.required).map((f) => f.name)
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

/**
 * The MCP servers an ACP client passed on `session/new` / `session/load`, as
 * Houston configs. Ids are `acp-<name>`, reduced to the `[\w-]` an MCP id allows
 * and de-duplicated (the run then prefixes `run-`, as for any per-run server);
 * entries that don't parse are skipped rather than failing the session, and
 * reported back so the caller can log them.
 */
export function acpMcpServersToConfigs(raw: unknown): { servers: McpServerConfig[]; skipped: string[] } {
  const servers: McpServerConfig[] = []
  const skipped: string[] = []
  if (!Array.isArray(raw)) return { servers, skipped }
  const taken = new Set<string>()
  const pairs = (v: unknown): Record<string, string> => {
    const out: Record<string, string> = {}
    if (!Array.isArray(v)) return out
    for (const p of v) {
      if (p && typeof p === 'object' && typeof p.name === 'string' && typeof p.value === 'string') out[p.name] = p.value
    }
    return out
  }
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue
    const o = s as Record<string, unknown>
    const name = typeof o.name === 'string' ? o.name.trim() : ''
    if (!name) {
      skipped.push('(unnamed)')
      continue
    }
    const slug = name.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'server'
    let id = `acp-${slug}`
    for (let n = 2; taken.has(id); n++) id = `acp-${slug}-${n}`
    const type = o.type
    if (type === 'http' || type === 'sse') {
      if (typeof o.url !== 'string' || !/^https?:\/\//i.test(o.url)) {
        skipped.push(name)
        continue
      }
      taken.add(id)
      servers.push({
        id,
        name,
        transport: type,
        command: '',
        url: o.url,
        headers: pairs(o.headers),
        enabled: true
      })
    } else if (type === undefined || type === 'stdio') {
      if (typeof o.command !== 'string' || !o.command.trim()) {
        skipped.push(name)
        continue
      }
      taken.add(id)
      servers.push({
        id,
        name,
        transport: 'stdio',
        command: o.command,
        args: Array.isArray(o.args) ? o.args.filter((a): a is string => typeof a === 'string') : [],
        env: pairs(o.env),
        enabled: true
      })
    } else {
      skipped.push(name)
    }
  }
  return { servers, skipped }
}

/** A `file://` URI as a path, or null for any other scheme. */
function uriToPath(uri: string): string | null {
  if (!uri.startsWith('file://')) return null
  try {
    return fileURLToPath(uri)
  } catch {
    return null
  }
}

/**
 * An ACP prompt (content blocks) as the text and images of one user turn. Embedded
 * resources become fenced context under their path; a resource link becomes a
 * pointer the agent can open with its own tools. Unsupported blocks (audio, a
 * binary resource that isn't an image) are named rather than silently dropped.
 */
export function promptFromBlocks(blocks: unknown): { text: string; images: ImageAttachment[] } {
  if (!Array.isArray(blocks)) throw new AcpError(ACP_ERROR.invalidParams, 'prompt must be an array of content blocks')
  const parts: string[] = []
  const rawImages: { mediaType: string; data: string }[] = []
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue
    const block = b as Record<string, unknown>
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string') parts.push(block.text)
        break
      case 'image':
        if (typeof block.data === 'string' && typeof block.mimeType === 'string') {
          rawImages.push({ mediaType: block.mimeType, data: block.data })
        }
        break
      case 'resource': {
        const r = (block.resource ?? {}) as Record<string, unknown>
        const uri = typeof r.uri === 'string' ? r.uri : ''
        const label = uriToPath(uri) ?? uri
        if (typeof r.text === 'string') {
          parts.push(`Contents of ${label}:\n\`\`\`\n${r.text}\n\`\`\``)
        } else if (typeof r.blob === 'string' && typeof r.mimeType === 'string' && r.mimeType.startsWith('image/')) {
          rawImages.push({ mediaType: r.mimeType, data: r.blob })
        } else {
          parts.push(`[Attached ${label} could not be included: binary content is not supported]`)
        }
        break
      }
      case 'resource_link': {
        const uri = typeof block.uri === 'string' ? block.uri : ''
        const path = uriToPath(uri)
        parts.push(path ? `Referenced file: ${path}` : `Referenced resource: ${uri}`)
        break
      }
      default:
        parts.push(`[A ${String(block.type)} attachment was not included: this agent does not support it]`)
    }
  }
  const images = sanitizeAttachments(rawImages)
  if (images.length < rawImages.length) {
    parts.push(`[${rawImages.length - images.length} image(s) skipped: unsupported type or too large]`)
  }
  return { text: parts.join('\n\n'), images }
}

/**
 * The `session/update`s that replay a stored conversation for `session/load`:
 * the user's turns, the assistant's text and reasoning, and each tool call with its
 * result. Loop-injected notes and compaction summaries are left out (they were
 * never the user's words), and a turn Houston wrote shows as what the user did.
 * A run that ended other than by finishing (an error, a Stop, a limit) replays as
 * the notice saying so, as a `notice` update for an editor that presents them and
 * on the thought stream otherwise, the same as live.
 */
export function replayUpdates(
  messages: ChatMessage[],
  cwd: string,
  opts: { notices?: boolean } = {}
): AcpSessionUpdate[] {
  const out: AcpSessionUpdate[] = []
  const text = (sessionUpdate: string, t: string): AcpSessionUpdate => ({
    sessionUpdate,
    content: { type: 'text', text: t }
  })
  const notice = (message: string, severity: 'info' | 'warning' | 'error'): AcpSessionUpdate =>
    opts.notices
      ? { sessionUpdate: 'notice', severity, title: message }
      : text('agent_thought_chunk', `\n${message}\n`)
  for (const m of messages) {
    replayMessage(m)
    for (const r of runEndRecords(m)) {
      out.push(notice(runEndNoticeText(r), r.reason === 'error' ? 'error' : r.reason === 'limit' ? 'warning' : 'info'))
    }
  }
  return out

  function replayMessage(m: ChatMessage): void {
    if (m.role === 'user') {
      if (m.content.startsWith(SYSTEM_NOTE_PREFIX) || m.content.startsWith(COMPACTION_SUMMARY_PREFIX)) return
      const shown = m.invokedAs ? invocationText(m.invokedAs) : m.content
      if (shown) out.push(text('user_message_chunk', shown))
      for (const img of m.images ?? []) {
        out.push({ sessionUpdate: 'user_message_chunk', content: { type: 'image', data: img.data, mimeType: img.mediaType } })
      }
    } else if (m.role === 'assistant') {
      for (const r of m.reasoning ?? []) if (r.text) out.push(text('agent_thought_chunk', r.text))
      if (m.content) out.push(text('agent_message_chunk', m.content))
      for (const c of m.toolCalls ?? []) {
        if (c.name === 'todo_write') {
          out.push(planUpdate(c.arguments))
          continue
        }
        out.push({
          sessionUpdate: 'tool_call',
          toolCallId: c.id,
          title: acpToolTitle(c.name, c.arguments),
          kind: acpToolKind(c.name),
          status: 'completed',
          rawInput: c.arguments,
          locations: toolLocations(cwd, c.arguments)
        })
      }
    } else if (m.role === 'tool' && m.toolCallId && m.toolName !== 'todo_write') {
      out.push({
        sessionUpdate: 'tool_call_update',
        toolCallId: m.toolCallId,
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: clip(m.content) } }]
      })
    }
  }
}

function planUpdate(args: Record<string, unknown>): AcpSessionUpdate {
  return {
    sessionUpdate: 'plan',
    entries: parseTodosSafe(args.todos).map((t) => ({ content: t.content, priority: 'medium', status: t.status }))
  }
}

function clip(s: string): string {
  return s.length > MAX_TOOL_OUTPUT ? `${s.slice(0, MAX_TOOL_OUTPUT)}\n… (output shortened)` : s
}

function modeState(current: ApprovalPolicy): Record<string, unknown> {
  return { currentModeId: current, availableModes: ACP_MODES }
}

/** Read a file for a diff only when it sits inside the workspace: a regular, small file, not via a symlink. */
function defaultReadFile(path: string): string | null {
  try {
    const st = lstatSync(path)
    if (!st.isFile() || st.size > MAX_DIFF_FILE_BYTES) return null
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * Whether `path` resolves inside the workspace, symlinks included: the path (or,
 * for a file not created yet, its parent) is compared after realpath on both sides,
 * so a symlinked directory can't route a diff read to a file outside the folder.
 */
function insideWorkspace(cwd: string, path: string): boolean {
  const real = (p: string): string | null => {
    try {
      return realpathSync(p)
    } catch {
      return null
    }
  }
  const root = real(cwd)
  const target = real(path) ?? (() => {
    const parent = real(dirname(path))
    return parent ? join(parent, basename(path)) : null
  })()
  if (!root || !target) return false
  const rel = relative(root, target)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

// ---- Slash commands and session config options ----

/**
 * The built-in commands an editor gets: the ones that make sense without a terminal
 * (no `/vim`, `/theme`, `/resume`: the editor has its own ways to do those).
 */
export const ACP_COMMAND_NAMES = [
  'review',
  'init',
  'compact',
  'agent',
  'plan',
  'ask',
  'auto',
  'full',
  'approval',
  'model',
  'reasoning',
  'skills',
  'agents',
  'help'
] as const

/** The slash commands offered in an editor: those built-ins, then the workspace's own. */
export function acpCommands(custom: Command[] = []): Command[] {
  const names: readonly string[] = ACP_COMMAND_NAMES
  return mergeCommands(
    builtinCommands('tui').filter((c) => names.includes(c.name)),
    custom
  )
}

/** The `available_commands_update` entries for `commands`. */
export function acpAvailableCommands(
  commands: Command[]
): { name: string; description: string; input?: { hint: string } }[] {
  return commands.map((c) => ({
    name: c.name,
    description: c.description,
    ...(c.args ? { input: { hint: c.args } } : {})
  }))
}

/** The approval mode each mode command (and `/approval <word>`) selects. */
const MODE_COMMANDS: Readonly<Record<string, ApprovalPolicy>> = {
  plan: 'plan',
  ask: 'ask',
  auto: 'auto-edit',
  'auto-edit': 'auto-edit',
  full: 'full-auto',
  'full-auto': 'full-auto'
}

/** The config option ids this server offers. */
export const ACP_CONFIG = { model: 'model', effort: 'reasoning_effort' } as const

const EFFORT_NAMES: Record<ReasoningEffort, string> = {
  off: 'Off',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high'
}

export interface AcpConfigOption {
  id: string
  name: string
  description?: string
  category: 'model' | 'thought_level'
  type: 'select'
  currentValue: string
  options: { value: string; name: string; description?: string }[]
}

/** A model's config value: provider and model id, which together name what runs. */
export function modelConfigValue(providerId: string, model: string): string {
  return `${providerId}/${model}`
}

/**
 * The models an editor can pick: every model of a provider that is ready to use (a
 * key is set where one is needed), as the terminal's model picker lists them, plus
 * the session's own model when it is not among them.
 */
export function acpModelOptions(
  settings: AppSettings,
  current: { providerId: string; model: string }
): { value: string; name: string; description?: string; providerId: string; model: string }[] {
  const out: { value: string; name: string; description?: string; providerId: string; model: string }[] = []
  for (const p of settings.providers) {
    if (p.requiresKey && !p.hasKey) continue
    for (const m of p.models) {
      if (m.unavailableAt) continue
      const name = m.label ?? modelDisplayName(p.kind, m.id)
      out.push({
        value: modelConfigValue(p.id, m.id),
        name,
        ...(p.label ? { description: p.label } : {}),
        providerId: p.id,
        model: m.id
      })
    }
  }
  const currentValue = modelConfigValue(current.providerId, current.model)
  if (!out.some((o) => o.value === currentValue)) {
    out.unshift({ value: currentValue, name: current.model, providerId: current.providerId, model: current.model })
  }
  return out
}

/** The session config options: the chat's model and its reasoning effort. */
export function acpConfigOptions(
  settings: AppSettings,
  s: { providerId: string; model: string; effort?: ReasoningEffort }
): AcpConfigOption[] {
  const effort = s.effort ?? (isReasoningEffort(settings.reasoningEffort) ? settings.reasoningEffort : DEFAULT_REASONING_EFFORT)
  return [
    {
      id: ACP_CONFIG.model,
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: modelConfigValue(s.providerId, s.model),
      options: acpModelOptions(settings, s).map(({ value, name, description }) => ({
        value,
        name,
        ...(description ? { description } : {})
      }))
    },
    {
      id: ACP_CONFIG.effort,
      name: 'Reasoning effort',
      description: 'How hard the model thinks before it answers',
      category: 'thought_level',
      type: 'select',
      currentValue: effort,
      options: REASONING_EFFORTS.map((e) => ({ value: e, name: EFFORT_NAMES[e] }))
    }
  ]
}

/**
 * Resolve a `/model` argument against the models on offer: a config value
 * (`provider/model`), a bare model id, or a provider id (its default model).
 */
export function resolveAcpModel(
  arg: string,
  settings: AppSettings,
  current: { providerId: string; model: string }
): { providerId: string; model: string } | null {
  const options = acpModelOptions(settings, current)
  const exact = options.find((o) => o.value === arg) ?? options.find((o) => o.model === arg)
  if (exact) return { providerId: exact.providerId, model: exact.model }
  const provider = settings.providers.find((p) => p.id === arg)
  const model = provider ? (provider.defaultModel ?? provider.models[0]?.id) : undefined
  const pick = model ? options.find((o) => o.providerId === provider!.id && o.model === model) : undefined
  return pick ? { providerId: pick.providerId, model: pick.model } : null
}

// ---- The server ----

export interface AcpServer {
  /** Feed one received line (a JSON-RPC message). */
  receive: (line: string) => void
  /** The input ended: fail requests to the client and wait for live prompts to finish. */
  close: () => Promise<void>
  /**
   * Stop serving now: cancel every live prompt instead of letting it finish. With
   * `peerGone` (the client's end of the output broke) nothing more is written either.
   * Then `close` as usual.
   */
  stop: (opts?: { peerGone?: boolean }) => void
  /** Called once when a write to the client fails: there is no one left to serve. */
  onPeerGone?: () => void
}

/**
 * How many sessions keep their message log in memory. An editor can open many
 * sessions over a long-lived server; past this many, the least recently used idle
 * ones drop their log and reload it from the store when prompted again.
 */
export const ACP_RESIDENT_SESSIONS = 8

export function createAcpServer(deps: AcpDeps): AcpServer {
  const newId = deps.newId ?? randomUUID
  const log = deps.log ?? (() => {})
  const readFile = deps.readFile ?? defaultReadFile
  // Ordered least to most recently used (see `touch`).
  const sessions = new Map<string, Session>()
  const running = new Set<Promise<unknown>>()
  let clientCaps: AcpClientCapabilities = {}
  let inputClosed = false

  // Requests this server sent to the client, awaiting a response.
  let nextRequestId = 1
  const outgoing = new Map<JsonRpcId, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  let peerGone = false
  const frame = (m: JsonRpcMessage): void => {
    if (peerGone) return
    try {
      deps.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`)
    } catch (e) {
      // The client's end broke (EPIPE): a run left going would keep editing files
      // for a reader that is gone.
      log(`acp: write to the client failed: ${String(e)}`)
      stop({ peerGone: true })
      server.onPeerGone?.()
    }
  }
  const notify = (method: string, params: unknown): void => frame({ method, params })
  const request = (method: string, params: unknown): Promise<unknown> => {
    if (inputClosed) return Promise.reject(new Error('connection closed'))
    const id = nextRequestId++
    return new Promise((resolvePromise, reject) => {
      outgoing.set(id, { resolve: resolvePromise, reject })
      frame({ id, method, params })
    })
  }
  const update = (sessionId: string, u: AcpSessionUpdate): void => notify('session/update', { sessionId, update: u })

  const track = <T>(p: Promise<T>): Promise<T> => {
    running.add(p)
    void p.finally(() => running.delete(p)).catch(() => {})
    return p
  }

  /**
   * Mark a session most recently used, then drop the message logs of the least
   * recently used sessions past `ACP_RESIDENT_SESSIONS`. A session with a run in
   * progress, or whose latest messages did not reach the store, keeps its log.
   */
  const touch = (s: Session): void => {
    sessions.delete(s.id)
    sessions.set(s.id, s)
    let resident = 0
    for (const x of sessions.values()) if (x.messages) resident++
    for (const x of sessions.values()) {
      if (resident <= ACP_RESIDENT_SESSIONS) break
      if (x === s || !x.messages || x.runId || !x.saved) continue
      x.messages = null
      resident--
    }
  }

  /** A session's messages, reloaded from the store when they were dropped. */
  const messagesOf = (s: Session): ChatMessage[] => {
    if (s.messages) return s.messages
    let stored: AcpStoredSession | null = null
    try {
      stored = deps.store.get(s.id)
    } catch (e) {
      log(`acp: failed to reload session ${s.id}: ${String(e)}`)
    }
    if (!stored) throw new AcpError(ACP_ERROR.notFound, `No saved session ${s.id}`)
    s.messages = [...stored.messages]
    s.saved = true
    return s.messages
  }

  const sessionOf = (params: unknown): Session => {
    const id = (params as { sessionId?: unknown } | undefined)?.sessionId
    const s = typeof id === 'string' ? sessions.get(id) : undefined
    if (!s) throw new AcpError(ACP_ERROR.notFound, `Unknown session: ${String(id)}`)
    return s
  }

  const requireCwd = (params: unknown): string => {
    const cwd = (params as { cwd?: unknown } | undefined)?.cwd
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
      throw new AcpError(ACP_ERROR.invalidParams, 'cwd must be an absolute path')
    }
    try {
      if (!statSync(cwd).isDirectory()) throw new Error('not a directory')
    } catch {
      throw new AcpError(ACP_ERROR.invalidParams, `cwd is not a directory: ${cwd}`)
    }
    return cwd
  }

  /** The model a session runs on: a loaded chat's own (`resumed`) while its provider is set up, else the default. */
  const resolveModel = (resumed?: { providerId?: string; model?: string }): { providerId: string; model: string } => {
    const r = resolveHeadlessModel(deps.getSettings(), {}, resumed)
    if ('error' in r) throw new AcpError(r.recoverable ? ACP_ERROR.authRequired : ACP_ERROR.internal, r.error)
    return r
  }

  const clientServers = (params: unknown): McpServerConfig[] => {
    const { servers, skipped } = acpMcpServersToConfigs((params as { mcpServers?: unknown })?.mcpServers)
    if (skipped.length) log(`acp: skipped MCP server(s) the client passed: ${skipped.join(', ')}`)
    return servers
  }

  const defaultMode = (): ApprovalPolicy => {
    const p = deps.defaultPolicy ?? deps.getSettings().approvalPolicy
    return isApprovalPolicy(p) ? p : 'ask'
  }

  // ---- Method handlers ----

  const initialize = (params: unknown): unknown => {
    const p = (params ?? {}) as { clientCapabilities?: AcpClientCapabilities }
    clientCaps = p.clientCapabilities && typeof p.clientCapabilities === 'object' ? p.clientCapabilities : {}
    return {
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        mcpCapabilities: { http: true, sse: true },
        sessionCapabilities: { list: {} }
      },
      // Credentials resolve the way the CLI does (environment, then the profile's
      // credential store). An editor that can run a terminal gets a way to set one up:
      // the interactive client opens its provider setup when none is configured.
      authMethods: clientCaps.auth?.terminal
        ? [
            {
              type: 'terminal',
              id: 'houston-setup',
              name: 'Set up a model provider',
              description: 'Opens Houston in a terminal to add a provider and API key',
              args: ['-i']
            }
          ]
        : [],
      agentInfo: { name: 'houston', title: 'Houston', version: deps.version }
    }
  }

  const newSession = (params: unknown): unknown => {
    const cwd = requireCwd(params)
    const mcpServers = clientServers(params)
    const { providerId, model } = resolveModel()
    const { id } = deps.store.create({ workspace: cwd, providerId, model })
    const mode = defaultMode()
    const session: Session = {
      id,
      cwd,
      providerId,
      model,
      mode,
      messages: [],
      saved: true,
      mcpServers,
      runId: null,
      cancelled: false,
      costUsd: 0,
      context: null
    }
    sessions.set(id, session)
    touch(session)
    announce(session)
    return { sessionId: id, modes: modeState(mode), configOptions: configOptionsOf(session) }
  }

  const loadSession = (params: unknown): unknown => {
    const p = (params ?? {}) as { sessionId?: unknown }
    if (typeof p.sessionId !== 'string') throw new AcpError(ACP_ERROR.invalidParams, 'sessionId is required')
    const cwd = requireCwd(params)
    const live = sessions.get(p.sessionId)
    if (live?.runId) throw new AcpError(ACP_ERROR.invalidRequest, 'That session is running a prompt')
    const stored = deps.store.get(p.sessionId)
    if (!stored) throw new AcpError(ACP_ERROR.notFound, `No saved session ${p.sessionId}`)
    const mcpServers = clientServers(params)
    // The chat keeps its own model and effort, as a headless --resume and the other
    // clients do. Only when its provider is gone does it move, and then the stored meta
    // follows what will actually run. Best-effort.
    const { providerId, model } = resolveModel(stored)
    if (providerId !== stored.providerId || model !== stored.model) {
      try {
        deps.store.setModel(stored.id, providerId, model)
      } catch {
        // persistence is best-effort
      }
    }
    const effort = isReasoningEffort(stored.reasoningEffort) ? stored.reasoningEffort : undefined
    if (stored.workspace !== cwd) {
      log(`acp: session ${stored.id} was saved for ${stored.workspace}; continuing it in ${cwd}`)
    }
    // The mode the user last chose for this chat, as the terminal restores it; a chat
    // that never had one starts on the default.
    const mode = live?.mode ?? (isApprovalPolicy(stored.approvalPolicy) ? stored.approvalPolicy : defaultMode())
    const session: Session = {
      id: stored.id,
      cwd,
      providerId,
      model,
      mode,
      ...(effort ? { effort } : {}),
      messages: [...stored.messages],
      saved: true,
      mcpServers,
      runId: null,
      cancelled: false,
      costUsd: live?.costUsd ?? 0,
      context: live?.context ?? null
    }
    sessions.set(stored.id, session)
    touch(session)
    const notices = Boolean(clientCaps.session && typeof clientCaps.session === 'object' && clientCaps.session.notices)
    for (const u of replayUpdates(stored.messages, cwd, { notices })) update(stored.id, u)
    if (stored.title) sendTitle(session, stored.title, stored.updatedAt)
    announce(session)
    return { modes: modeState(mode), configOptions: configOptionsOf(session) }
  }

  const configOptionsOf = (s: Session): AcpConfigOption[] => acpConfigOptions(deps.getSettings(), s)

  /** Save a setting the user changed on this chat. Best-effort, like every store write here. */
  const saveSettings = (s: Session, patch: ConversationSettingsPatch): void => {
    try {
      if (deps.store.setSettings) deps.store.setSettings(s.id, patch)
      else if (patch.providerId && patch.model) deps.store.setModel(s.id, patch.providerId, patch.model)
    } catch (e) {
      log(`acp: failed to save the settings of session ${s.id}: ${String(e)}`)
    }
  }

  const sendTitle = (s: Session, title: string, updatedAt?: number): void => {
    s.title = title
    update(s.id, {
      sessionUpdate: 'session_info_update',
      title,
      ...(updatedAt ? { updatedAt: new Date(updatedAt).toISOString() } : {})
    })
  }

  /** The chat's title once a turn has given it one (or a new one): tell the editor. */
  const refreshTitle = (s: Session): void => {
    let title: string | undefined
    try {
      title = deps.store.title?.(s.id)
    } catch {
      return
    }
    if (title && title !== s.title) sendTitle(s, title, Date.now())
  }

  const loadCustomCommands = async (cwd: string): Promise<Command[]> => {
    try {
      return (await deps.commands?.(cwd)) ?? []
    } catch (e) {
      log(`acp: could not load the workspace commands: ${String(e)}`)
      return []
    }
  }

  /**
   * Tell the editor which slash commands the session has. Sent after the response
   * that created or loaded the session, so the editor already knows its id.
   */
  const announce = (s: Session): void => {
    setImmediate(() => {
      void loadCustomCommands(s.cwd).then((custom) => {
        if (!sessions.has(s.id)) return
        update(s.id, { sessionUpdate: 'available_commands_update', availableCommands: acpAvailableCommands(acpCommands(custom)) })
      })
    })
  }

  /** Switch a session's approval mode, as the user asked: the session, its live run, the chat. */
  const applyMode = (s: Session, mode: ApprovalPolicy): void => {
    s.mode = mode
    if (s.runId) deps.setRunPolicy(s.runId, mode)
    saveSettings(s, { approvalPolicy: mode })
  }

  const applyModel = (s: Session, providerId: string, model: string): void => {
    s.providerId = providerId
    s.model = model
    saveSettings(s, { providerId, model })
  }

  const applyEffort = (s: Session, effort: ReasoningEffort): void => {
    s.effort = effort
    saveSettings(s, { reasoningEffort: effort })
  }

  const setConfigOption = (params: unknown): unknown => {
    const s = sessionOf(params)
    const { configId, value } = (params ?? {}) as { configId?: unknown; value?: unknown }
    if (configId === ACP_CONFIG.model) {
      const picked =
        typeof value === 'string' ? acpModelOptions(deps.getSettings(), s).find((o) => o.value === value) : undefined
      if (!picked) throw new AcpError(ACP_ERROR.invalidParams, `Unknown model: ${String(value)}`)
      applyModel(s, picked.providerId, picked.model)
    } else if (configId === ACP_CONFIG.effort) {
      if (!isReasoningEffort(value)) {
        throw new AcpError(
          ACP_ERROR.invalidParams,
          `Unknown reasoning effort: ${String(value)} (use ${REASONING_EFFORTS.join(', ')})`
        )
      }
      applyEffort(s, value)
    } else {
      throw new AcpError(ACP_ERROR.invalidParams, `Unknown config option: ${String(configId)}`)
    }
    return { configOptions: configOptionsOf(s) }
  }

  const listSessions = (params: unknown): unknown => {
    const cwd = (params as { cwd?: unknown } | undefined)?.cwd
    const all = deps.store
      .list()
      .filter((s) => typeof cwd !== 'string' || s.workspace === cwd)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, 100)
    return {
      sessions: all.map((s) => ({
        sessionId: s.id,
        cwd: s.workspace,
        ...(s.title ? { title: s.title } : {}),
        ...(s.updatedAt ? { updatedAt: new Date(s.updatedAt).toISOString() } : {})
      }))
    }
  }

  const setMode = (params: unknown): unknown => {
    const s = sessionOf(params)
    const modeId = (params as { modeId?: unknown }).modeId
    if (!isApprovalPolicy(modeId)) {
      throw new AcpError(ACP_ERROR.invalidParams, `Unknown mode: ${String(modeId)} (use ${APPROVAL_POLICIES.join(', ')})`)
    }
    applyMode(s, modeId)
    return {}
  }

  const cancel = (params: unknown): void => {
    const id = (params as { sessionId?: unknown } | undefined)?.sessionId
    const s = typeof id === 'string' ? sessions.get(id) : undefined
    if (!s?.runId) return
    s.cancelled = true
    deps.cancelRun(s.runId)
  }

  /** Show the editor a reply Houston wrote itself (a command's answer), not the model. */
  const reply = (s: Session, textOut: string): { stopReason: 'end_turn' } => {
    update(s.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: textOut } })
    return { stopReason: 'end_turn' }
  }

  const busy = (s: Session): boolean => Boolean(s.runId || s.compacting)

  /**
   * A prompt that starts with one of the session's slash commands: either a turn to
   * run (a template command, `/agent`), labelled with what the user typed, or a
   * command handled here, which answers with a reply. Null for anything else, which
   * runs as the user wrote it (a path like `/tmp/x` is not a command).
   */
  const runCommand = async (
    s: Session,
    line: string
  ): Promise<{ kind: 'turn'; turn: InvokedTurn } | { kind: 'reply'; text: string } | null> => {
    const parsed = parseSlashCommand(line)
    if (!parsed || !/^[\w:-]+$/.test(parsed.name)) return null
    const commands = acpCommands(await loadCustomCommands(s.cwd))
    const cmd = resolveCommand(commands, parsed.name)
    if (!cmd) return null
    const arg = parsed.args
    const settings = deps.getSettings()
    switch (cmd.name) {
      case 'plan':
      case 'ask':
      case 'auto':
      case 'full': {
        const mode = MODE_COMMANDS[cmd.name]
        applyMode(s, mode)
        update(s.id, { sessionUpdate: 'current_mode_update', currentModeId: mode })
        return { kind: 'reply', text: `Approval mode: ${ACP_MODES.find((m) => m.id === mode)?.name ?? mode}.` }
      }
      case 'approval': {
        const word = arg.trim().toLowerCase()
        if (!word) {
          const lines = ACP_MODES.map((m) => `- ${m.id}${m.id === s.mode ? ' (current)' : ''}: ${m.description}`)
          return { kind: 'reply', text: `Approval mode: ${s.mode}\n\n${lines.join('\n')}` }
        }
        const mode = isApprovalPolicy(word) ? word : MODE_COMMANDS[word]
        if (!mode) return { kind: 'reply', text: `Unknown approval mode: ${word} (use ${APPROVAL_POLICIES.join(', ')})` }
        applyMode(s, mode)
        update(s.id, { sessionUpdate: 'current_mode_update', currentModeId: mode })
        return { kind: 'reply', text: `Approval mode: ${ACP_MODES.find((m) => m.id === mode)?.name ?? mode}.` }
      }
      case 'model': {
        const want = arg.trim()
        if (!want) {
          const current = modelConfigValue(s.providerId, s.model)
          const lines = acpModelOptions(settings, s).map(
            (o) => `- ${o.value}${o.name !== o.model ? ` (${o.name})` : ''}${o.value === current ? ', current' : ''}`
          )
          return { kind: 'reply', text: `Model: ${current}\n\n${lines.join('\n')}` }
        }
        const picked = resolveAcpModel(want, settings, s)
        if (!picked) return { kind: 'reply', text: `No model named ${want} is set up. Run /model to list them.` }
        applyModel(s, picked.providerId, picked.model)
        update(s.id, { sessionUpdate: 'config_option_update', configOptions: configOptionsOf(s) })
        return { kind: 'reply', text: `Model: ${modelConfigValue(picked.providerId, picked.model)}.` }
      }
      case 'reasoning': {
        const want = arg.trim().toLowerCase()
        const current = configOptionsOf(s).find((o) => o.id === ACP_CONFIG.effort)?.currentValue
        if (!want) return { kind: 'reply', text: `Reasoning effort: ${current} (${REASONING_EFFORTS.join(', ')})` }
        if (!isReasoningEffort(want)) {
          return { kind: 'reply', text: `Unknown reasoning effort: ${want} (use ${REASONING_EFFORTS.join(', ')})` }
        }
        applyEffort(s, want)
        update(s.id, { sessionUpdate: 'config_option_update', configOptions: configOptionsOf(s) })
        return { kind: 'reply', text: `Reasoning effort: ${want}.` }
      }
      case 'skills':
      case 'agents': {
        const list = cmd.name === 'skills' ? deps.skills : deps.agents
        let items: { name: string; description: string }[] = []
        try {
          items = (await list?.(s.cwd)) ?? []
        } catch (e) {
          log(`acp: could not list the workspace ${cmd.name}: ${String(e)}`)
        }
        const where = cmd.name === 'skills' ? '.houston/skills' : '.houston/agents'
        if (!items.length) return { kind: 'reply', text: `No ${cmd.name} in this workspace (${where}).` }
        return { kind: 'reply', text: items.map((i) => `- ${i.name}${i.description ? `: ${i.description}` : ''}`).join('\n') }
      }
      case 'help':
        return {
          kind: 'reply',
          text: commands.map((c) => `- /${c.name}${c.args ? ` ${c.args}` : ''}: ${c.description}`).join('\n')
        }
      case 'compact':
        return { kind: 'reply', text: await compactNow(s) }
      case 'agent': {
        const turn = agentTurn(arg, line)
        return turn ? { kind: 'turn', turn } : { kind: 'reply', text: 'Use /agent <name> <task>. /agents lists them.' }
      }
      default: {
        // A template command: first-party (`/review`, `/init`) or the workspace's own.
        const turn = commandTurn(cmd, arg, line)
        return turn ? { kind: 'turn', turn } : null
      }
    }
  }

  /** `/compact`: summarize the stored chat's older turns, then reload it. */
  const compactNow = async (s: Session): Promise<string> => {
    if (!deps.compact) return 'Compacting is not available here.'
    // The store is what gets summarized, so it must hold the latest turns first.
    if (!s.saved && s.messages) {
      try {
        deps.store.setMessages(s.id, s.messages)
        s.saved = true
      } catch (e) {
        return `Could not save the chat before compacting it: ${String(e)}`
      }
    }
    s.compacting = true
    try {
      const r = await deps.compact(s.id, s.providerId, s.model)
      if (!r.ok) return `Nothing was compacted${r.error ? `: ${r.error}` : '.'}`
      if (r.summarized === 0) return 'Nothing to compact yet.'
      // Reloaded from the store on the next prompt.
      s.messages = null
      s.saved = true
      return `Summarized ${r.summarized} earlier message${r.summarized === 1 ? '' : 's'}.`
    } catch (e) {
      return `Compacting failed: ${String(e)}`
    } finally {
      s.compacting = false
    }
  }

  const prompt = async (params: unknown): Promise<unknown> => {
    const s = sessionOf(params)
    if (busy(s)) throw new AcpError(ACP_ERROR.invalidRequest, 'A prompt is already running in this session')
    const { text: typed, images } = promptFromBlocks((params as { prompt?: unknown }).prompt)
    if (!typed.trim() && images.length === 0) throw new AcpError(ACP_ERROR.invalidParams, 'The prompt is empty')
    const command = typed.trimStart().startsWith('/') ? await runCommand(s, typed.trim()) : null
    if (command?.kind === 'reply') return reply(s, command.text)
    // The command lookup read the disk: another prompt may have started meanwhile.
    if (busy(s)) throw new AcpError(ACP_ERROR.invalidRequest, 'A prompt is already running in this session')
    const text = command ? command.turn.text : typed
    const invokedAs = command ? command.turn.invokedAs : undefined
    const prior = messagesOf(s)

    const runId = newId()
    s.runId = runId
    s.cancelled = false
    touch(s)
    const messages: ChatMessage[] = [
      ...prior,
      { role: 'user', content: text, ...(invokedAs ? { invokedAs } : {}), ...(images.length ? { images } : {}) }
    ]
    s.messages = messages
    // The new turn is not in the store until the run saves it.
    s.saved = false
    const turn = createTurn(s, runId)
    const req: AgentRunRequest = {
      runId,
      conversationId: s.id,
      workspace: s.cwd,
      providerId: s.providerId,
      model: s.model,
      approvalPolicy: s.mode,
      ...(s.effort ? { reasoningEffort: s.effort } : {}),
      messages,
      // Per-run servers, like the headless --mcp-config: merged as `run-<id>`, values
      // used as given, never saved to settings.
      ...(s.mcpServers.length ? { extraMcpServers: s.mcpServers } : {})
    }
    try {
      await deps.startRun(req, turn.send, (m) => {
        s.messages = m
        s.saved = false
        try {
          deps.store.setMessages(s.id, m)
          s.saved = true
        } catch (e) {
          log(`acp: failed to save session ${s.id}: ${String(e)}`)
        }
      })
      // Blocking prompts the client is still answering resolve themselves once
      // their requests settle; nothing waits on them past the run.
    } finally {
      s.runId = null
      // Other sessions may have been held past the bound while this one ran.
      touch(s)
    }
    refreshTitle(s)
    if (s.cancelled || turn.state.stopReason === 'aborted') return { stopReason: 'cancelled' }
    if (turn.state.error) throw new AcpError(ACP_ERROR.internal, turn.state.error)
    if (turn.state.limit === 'max-steps' || turn.state.limit === 'max-cost') return { stopReason: 'max_turn_requests' }
    if (turn.state.limit === 'max-output' || turn.state.stopReason === 'max_tokens') return { stopReason: 'max_tokens' }
    return { stopReason: 'end_turn' }
  }

  // ---- One prompt turn: the AgentEvent → session/update mapping ----

  function createTurn(s: Session, runId: string) {
    const state: {
      stopReason: string | null
      error: string | null
      limit: RunLimitReason | null
    } = { stopReason: null, error: null, limit: null }
    // Tool calls already announced to the editor (a gated call is announced at its
    // approval prompt, before `tool_start`).
    const announced = new Set<string>()
    const calls = new Map<
      string,
      { name: string; args: Record<string, unknown>; progress: string[]; before?: Map<string, string | null> }
    >()
    const todoCalls = new Set<string>()
    const notices = Boolean(clientCaps.session && typeof clientCaps.session === 'object' && clientCaps.session.notices)
    const canElicit = Boolean(
      clientCaps.elicitation && typeof clientCaps.elicitation === 'object' && clientCaps.elicitation.form
    )

    const up = (u: AcpSessionUpdate): void => update(s.id, u)
    // A note for the user from outside the conversation. Editors that present
    // notices get one; elsewhere it rides the thought stream, which editors show
    // but keep apart from the answer.
    const notice = (message: string, severity: 'info' | 'warning' | 'error' = 'info'): void => {
      if (notices) up({ sessionUpdate: 'notice', severity, title: message })
      else up({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: `\n${message}\n` } })
    }

    const announce = (
      callId: string,
      name: string,
      args: Record<string, unknown>,
      kind: Parameters<typeof acpToolKind>[1],
      status: AcpToolStatus,
      content: AcpToolCallContent[] = [],
      preview?: FileDiffPreview[]
    ): void => {
      announced.add(callId)
      up({
        sessionUpdate: 'tool_call',
        toolCallId: callId,
        title: acpToolTitle(name, args),
        kind: acpToolKind(name, kind),
        status,
        rawInput: args,
        content,
        locations: toolLocations(s.cwd, args, preview)
      })
    }

    // A subagent's start, finished steps and end, as indented progress lines.
    const subagentLines = new SubagentTermLines()

    const progress = (callId: string, line: string): void => {
      const c = calls.get(callId)
      if (!c || !announced.has(callId)) return
      c.progress.push(line)
      if (c.progress.length > MAX_PROGRESS_LINES) c.progress.splice(0, c.progress.length - MAX_PROGRESS_LINES)
      up({
        sessionUpdate: 'tool_call_update',
        toolCallId: callId,
        content: [{ type: 'content', content: { type: 'text', text: c.progress.join('\n') } }]
      })
    }

    /** Full before/after text of the files an edit touched, when they can be read safely. */
    const snapshot = (preview: FileDiffPreview[] | undefined): Map<string, string | null> | undefined => {
      if (!preview?.length) return undefined
      const m = new Map<string, string | null>()
      for (const f of preview) {
        const abs = resolve(s.cwd, f.path)
        if (!insideWorkspace(s.cwd, abs)) return undefined
        m.set(abs, f.created ? null : readFile(abs))
        if (!f.created && m.get(abs) === null) return undefined
      }
      return m
    }

    const approval = async (e: Extract<AgentEvent, { type: 'tool_approval' }>): Promise<void> => {
      const args = e.args ?? {}
      const warnings: string[] = []
      if (e.egressHost) {
        warnings.push(
          `A shell command tried to reach ${e.egressHost}, which isn't on the sandbox's allowed domains, so it was blocked. Allow shell commands to reach this host for the rest of this session?`
        )
      } else if (e.shellNetwork) {
        warnings.push(
          'Allow shell commands to reach the network for the rest of this prompt? Shell runs in a sandbox that can read your files; declining runs commands offline.'
        )
      } else if (e.kind === 'shell' && e.sandboxed === false) {
        warnings.push('Runs UNSANDBOXED: this host has no OS confinement for shell commands.')
      } else if (e.sensitiveRead) {
        warnings.push('Reads a credential or secret file (asked even in full auto).')
      } else if (e.sensitiveWrite) {
        warnings.push('Changes a credential or secret file (asked even in full auto).')
      }
      if (e.shellOffline) warnings.push('The command runs without network access.')
      const content: AcpToolCallContent[] = [
        ...warnings.map((t) => ({ type: 'content' as const, content: { type: 'text' as const, text: t } })),
        ...(e.preview ? previewToDiffContent(s.cwd, e.preview) : [])
      ]
      if (!announced.has(e.callId)) announce(e.callId, e.name, args, e.kind, 'pending', content, e.preview)
      // The shell-network consent is a yes/no about egress, not a rule about a
      // command, so it gets no "always" choices.
      const options = e.egressHost
        ? [
            { optionId: 'allow', name: `Allow ${e.egressHost}`, kind: 'allow_once' },
            { optionId: 'deny', name: 'Keep blocked', kind: 'reject_once' }
          ]
        : e.shellNetwork
        ? [
            { optionId: 'allow', name: 'Allow network', kind: 'allow_once' },
            { optionId: 'deny', name: 'No network', kind: 'reject_once' }
          ]
        : [
            { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
            { optionId: 'rule-allow', name: 'Always allow', kind: 'allow_always' },
            { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
            { optionId: 'rule-deny', name: 'Always deny', kind: 'reject_always' }
          ]
      let decision: ToolApprovalDecision = 'deny'
      try {
        const res = (await request('session/request_permission', {
          sessionId: s.id,
          toolCall: { toolCallId: e.callId, title: e.summary, kind: acpToolKind(e.name, e.kind), status: 'pending', content },
          options
        })) as { outcome?: { outcome?: string; optionId?: string } } | null
        const picked = res?.outcome?.outcome === 'selected' ? res.outcome.optionId : undefined
        if (options.some((o) => o.optionId === picked)) decision = picked as ToolApprovalDecision
      } catch (err) {
        log(`acp: permission request failed, denying: ${String(err)}`)
      }
      if (decision === 'deny' || decision === 'rule-deny') {
        up({ sessionUpdate: 'tool_call_update', toolCallId: e.callId, status: 'failed' })
      }
      deps.resolveApproval(runId, e.callId, decision)
    }

    const question = async (e: Extract<AgentEvent, { type: 'tool_question' }>): Promise<void> => {
      if (!canElicit) {
        deps.resolveQuestion(runId, e.callId, ACP_NO_QUESTION_ANSWER)
        return
      }
      const choices = e.options.map((o) => ({
        const: o.label,
        title: o.label,
        ...(o.description ? { description: o.description } : {})
      }))
      const answerSchema = !choices.length
        ? { type: 'string', title: 'Answer' }
        : e.multiSelect
          ? { type: 'array', title: 'Answer', items: { anyOf: choices } }
          : { type: 'string', title: 'Answer', oneOf: choices }
      let answer = ACP_DECLINED_ANSWER
      try {
        const res = (await request('elicitation/create', {
          sessionId: s.id,
          toolCallId: e.callId,
          mode: 'form',
          message: e.question,
          requestedSchema: { type: 'object', properties: { answer: answerSchema }, required: ['answer'] }
        })) as { action?: string; content?: Record<string, unknown> } | null
        const v = res?.action === 'accept' ? res.content?.answer : undefined
        const given = Array.isArray(v) ? v.filter((x) => typeof x === 'string').join(', ') : typeof v === 'string' ? v : ''
        if (given.trim()) answer = given.trim().slice(0, 4000)
      } catch (err) {
        log(`acp: question request failed: ${String(err)}`)
      }
      deps.resolveQuestion(runId, e.callId, answer)
    }

    const planReview = async (e: Extract<AgentEvent, { type: 'plan_ready' }>): Promise<void> => {
      const body = planMarkdown(e.plan)
      const content: AcpToolCallContent[] = [{ type: 'content', content: { type: 'text', text: body } }]
      if (!announced.has(e.callId)) announce(e.callId, 'present_plan', {}, 'read', 'pending', content)
      else up({ sessionUpdate: 'tool_call_update', toolCallId: e.callId, content })
      let decision: PlanDecision = { kind: 'reject' }
      try {
        const res = (await request('session/request_permission', {
          sessionId: s.id,
          toolCall: { toolCallId: e.callId, title: `Plan: ${e.plan.title}`, kind: 'switch_mode', status: 'pending', content },
          options: [
            { optionId: 'accept-auto-edit', name: 'Accept and apply edits automatically', kind: 'allow_always' },
            { optionId: 'accept-ask', name: 'Accept and approve each edit', kind: 'allow_once' },
            { optionId: 'reject', name: 'Keep planning', kind: 'reject_once' }
          ]
        })) as { outcome?: { outcome?: string; optionId?: string } } | null
        const picked = res?.outcome?.outcome === 'selected' ? res.outcome.optionId : undefined
        if (picked === 'accept-auto-edit') decision = { kind: 'accept', mode: 'auto-edit' }
        else if (picked === 'accept-ask') decision = { kind: 'accept', mode: 'ask' }
      } catch (err) {
        log(`acp: plan review request failed, keeping the plan unexecuted: ${String(err)}`)
      }
      // Accepting switches the run off Plan mode (the loop does it); keep the
      // session's mode and the editor's mode picker in step.
      if (decision.kind === 'accept') {
        s.mode = decision.mode
        up({ sessionUpdate: 'current_mode_update', currentModeId: decision.mode })
      }
      deps.resolvePlan(runId, e.callId, decision)
    }

    const mcpElicitation = async (e: Extract<AgentEvent, { type: 'elicitation' }>): Promise<void> => {
      // Never fabricate values for an external server: without a form to show the
      // user, decline, so the server takes its documented no-answer path.
      if (!canElicit) {
        deps.resolveElicitation(runId, e.elicitId, { action: 'decline' })
        return
      }
      let result: ElicitationResult = { action: 'cancel' }
      try {
        const res = await request('elicitation/create', {
          sessionId: s.id,
          toolCallId: e.callId,
          mode: 'form',
          message: `MCP server "${e.serverId}" asks: ${e.message}`,
          requestedSchema: elicitationSchema(e.fields)
        })
        result = sanitizeElicitationResult(res) ?? { action: 'cancel' }
      } catch (err) {
        log(`acp: elicitation request failed, cancelling: ${String(err)}`)
      }
      deps.resolveElicitation(runId, e.elicitId, result)
    }

    // A blocking handler never throws past here, and always resolves its prompt.
    const block = (p: Promise<void>): void => void track(p.catch((err) => log(`acp: ${String(err)}`)))

    const send = (e: AgentEvent): void => {
      switch (e.type) {
        case 'text':
          up({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: e.delta } })
          break
        case 'reasoning':
          up({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: e.delta } })
          break
        case 'turn_discarded':
          // ACP has no way to take streamed text back, so say plainly that what
          // follows replaces the cut-off reply.
          up({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: '\n\n(The reply above was cut off; redoing it.)\n\n' }
          })
          break
        case 'steered':
          up({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: e.text } })
          break
        case 'tool_start': {
          if (e.name === 'todo_write') {
            // A todo update IS the plan: show it as one, not as a tool row.
            todoCalls.add(e.callId)
            up(planUpdate(e.args))
            break
          }
          const before = e.kind === 'write' ? snapshot(e.preview) : undefined
          calls.set(e.callId, { name: e.name, args: e.args, progress: [], ...(before ? { before } : {}) })
          if (announced.has(e.callId)) {
            up({
              sessionUpdate: 'tool_call_update',
              toolCallId: e.callId,
              status: 'in_progress',
              title: acpToolTitle(e.name, e.args),
              rawInput: e.args
            })
          } else {
            announce(
              e.callId,
              e.name,
              e.args,
              e.kind,
              'in_progress',
              e.preview ? previewToDiffContent(s.cwd, e.preview) : [],
              e.preview
            )
          }
          break
        }
        case 'tool_progress':
          if (e.message.trim()) progress(e.callId, e.message.trim())
          break
        case 'subagent':
          progress(e.parentCallId, `${e.status === 'running' ? '▷' : e.status === 'done' ? '✓' : '✗'} ${e.label}`)
          break
        case 'subagent_start':
        case 'subagent_step':
        case 'subagent_end': {
          const line = subagentLines.line(e)
          if (line) progress(e.parentCallId, `${'  '.repeat(line.depth - 1)}${line.text}`)
          break
        }
        case 'review_finding':
          progress(
            e.parentCallId,
            `[${e.finding.severity}] ${e.finding.title}${e.finding.location ? ` (${e.finding.location})` : ''}: ${e.finding.status}`
          )
          break
        case 'tool_result': {
          if (todoCalls.delete(e.callId)) {
            if (!e.ok) notice(`Todo list update failed: ${e.output}`, 'warning')
            break
          }
          const c = calls.get(e.callId)
          calls.delete(e.callId)
          const content: AcpToolCallContent[] = []
          if (e.ok && c?.before) {
            for (const [path, oldText] of c.before) {
              content.push({ type: 'diff', path, oldText, newText: readFile(path) ?? '' })
            }
          }
          if (e.output) content.push({ type: 'content', content: { type: 'text', text: clip(e.output) } })
          for (const img of e.images ?? []) {
            content.push({ type: 'content', content: { type: 'image', data: img.data, mimeType: img.mediaType } })
          }
          if (!announced.has(e.callId)) announce(e.callId, e.name, c?.args ?? {}, undefined, 'in_progress')
          up({
            sessionUpdate: 'tool_call_update',
            toolCallId: e.callId,
            status: e.ok ? 'completed' : 'failed',
            content
          })
          break
        }
        case 'tool_approval':
          block(approval(e))
          break
        case 'tool_question':
          block(question(e))
          break
        case 'plan_ready':
          block(planReview(e))
          break
        case 'elicitation':
          block(mcpElicitation(e))
          break
        case 'usage': {
          s.costUsd += e.cost
          // One event per model round of the agent itself; a subagent's or a
          // review's rounds arrive rolled up with inputTokens 0 and add only cost.
          if (e.inputTokens > 0) {
            const model = e.model ?? s.model
            const caps = deps
              .getSettings()
              .providers.find((p) => p.id === s.providerId)
              ?.models.find((m) => m.id === model)?.caps
            const size = resolveContextWindow(model, caps)
            if (size) s.context = { used: Math.min(e.inputTokens + e.outputTokens, size), size }
          }
          if (s.context) {
            up({
              sessionUpdate: 'usage_update',
              used: s.context.used,
              size: s.context.size,
              cost: { amount: Math.round(s.costUsd * 1e6) / 1e6, currency: 'USD' }
            })
          }
          break
        }
        case 'compaction':
          notice(`Compacted ${e.summarized} earlier messages to free up context.`)
          break
        case 'retry':
          notice(e.throttle ? throttleNotice(e.throttle, retryProgress(e)) : `Retrying (${retryProgress(e)}): ${e.message}`, 'warning')
          break
        case 'model_fallback':
          notice(`${e.from} is unavailable, falling back to ${e.to}: ${e.reason}`, 'warning')
          break
        case 'limit':
          state.limit = e.reason
          notice(limitNoticeText(e.reason), 'warning')
          break
        case 'receipt':
          notice(formatReceiptLines(e.receipt).join('\n'))
          break
        case 'verification':
          notice(`Verification ${e.passed ? 'passed' : 'failed'}.`, e.passed ? 'info' : 'warning')
          break
        case 'runtime_missing':
          notice(runtimeMissingLine(e), 'warning')
          break
        case 'notice':
          notice(e.message)
          break
        case 'error':
          state.error = e.message
          break
        case 'done':
          state.stopReason = e.stopReason
          if (e.stopReason === 'error' && !state.error) state.error = 'The run failed.'
          break
        // The GUI's queued-input follow-up; an ACP run never queues input, nor
        // steers one, so it has no steers to take back either.
        case 'turn_start':
        case 'steers_returned':
          break
        // Sent only to runs that set announceTools (the headless --json init line).
        case 'run_info':
          break
        default:
          assertNever(e, 'acp:unhandled agent event')
      }
    }

    return { send, state }
  }

  // ---- Dispatch ----

  const handleRequest = async (method: string, params: unknown): Promise<unknown> => {
    switch (method) {
      case 'initialize':
        return initialize(params)
      case 'authenticate':
        // Nothing to exchange: the next session/new re-reads the credentials.
        return {}
      case 'session/new':
        return newSession(params)
      case 'session/load':
        return loadSession(params)
      case 'session/list':
        return listSessions(params)
      case 'session/set_mode':
        return setMode(params)
      case 'session/set_config_option':
        return setConfigOption(params)
      case 'session/prompt':
        return prompt(params)
      default:
        throw new AcpError(ACP_ERROR.methodNotFound, `Method not found: ${method}`)
    }
  }

  const receive = (line: string): void => {
    if (!line.trim()) return
    let msg: JsonRpcMessage
    try {
      msg = JSON.parse(line) as JsonRpcMessage
    } catch {
      frame({ id: null, error: { code: ACP_ERROR.parse, message: 'Parse error' } })
      return
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      frame({ id: null, error: { code: ACP_ERROR.invalidRequest, message: 'Invalid request' } })
      return
    }
    // A response to one of our requests.
    if (msg.method === undefined) {
      const pending = msg.id !== undefined && msg.id !== null ? outgoing.get(msg.id) : undefined
      if (!pending) return
      outgoing.delete(msg.id as JsonRpcId)
      if (msg.error) pending.reject(new Error(msg.error.message))
      else pending.resolve(msg.result)
      return
    }
    if (typeof msg.method !== 'string') return
    // A notification.
    if (msg.id === undefined || msg.id === null) {
      if (msg.method === 'session/cancel') cancel(msg.params)
      return
    }
    const id = msg.id
    void track(
      handleRequest(msg.method, msg.params).then(
        (result) => frame({ id, result: result ?? null }),
        (err: unknown) => {
          if (err instanceof AcpError) {
            frame({ id, error: { code: err.code, message: err.message, ...(err.data ? { data: err.data } : {}) } })
          } else {
            log(`acp: ${msg.method} failed: ${String(err)}`)
            frame({ id, error: { code: ACP_ERROR.internal, message: (err as Error)?.message ?? String(err) } })
          }
        }
      )
    )
  }

  const stop = (opts: { peerGone?: boolean } = {}): void => {
    if (opts.peerGone) peerGone = true
    inputClosed = true
    for (const p of outgoing.values()) p.reject(new Error('connection closed'))
    outgoing.clear()
    for (const s of sessions.values()) {
      if (!s.runId) continue
      s.cancelled = true
      deps.cancelRun(s.runId)
    }
  }

  const close = async (): Promise<void> => {
    // The client can no longer answer, so every outstanding and future request to it
    // fails, and each blocking prompt resolves its safe way (deny, decline, reject).
    // Live prompts are left to finish rather than cancelled: a scripted client may
    // send its whole exchange and close its end while still reading the replies.
    // An editor that is done with the agent ends the process.
    inputClosed = true
    for (const p of outgoing.values()) p.reject(new Error('connection closed'))
    outgoing.clear()
    while (running.size) await Promise.allSettled([...running])
  }

  const server: AcpServer = { receive, close, stop }
  return server
}

/**
 * Serve ACP over a line stream until it ends. Every frame goes through
 * `deps.write`; the caller makes sure nothing else reaches stdout.
 */
export async function serveAcp(input: Readable, deps: AcpDeps, opts: ServeAcpOptions = {}): Promise<void> {
  const server = createAcpServer(deps)
  const rl = createInterface({ input, crlfDelay: Infinity })
  // Ending the session closes the reader explicitly: destroying the input stream
  // emits 'close' on it but never 'end', which is all readline listens for.
  const end = (peerGone: boolean): void => {
    server.stop({ peerGone })
    rl.close()
  }
  server.onPeerGone = () => rl.close()
  const closed = new Promise<void>((done) => rl.once('close', done))
  rl.on('line', (line) => server.receive(line))
  const onShutdown = (): void => end(false)
  const onOutputClosed = (): void => end(true)
  if (opts.shutdown?.aborted) onShutdown()
  else opts.shutdown?.addEventListener('abort', onShutdown, { once: true })
  if (opts.outputClosed?.aborted) onOutputClosed()
  else opts.outputClosed?.addEventListener('abort', onOutputClosed, { once: true })
  try {
    await closed
    await server.close()
  } finally {
    opts.shutdown?.removeEventListener('abort', onShutdown)
    opts.outputClosed?.removeEventListener('abort', onOutputClosed)
  }
}

export interface ServeAcpOptions {
  /** Aborted to stop serving (a termination signal): live prompts are cancelled. */
  shutdown?: AbortSignal
  /** Aborted when the client's end of the output broke: cancel, and write nothing more. */
  outputClosed?: AbortSignal
}
