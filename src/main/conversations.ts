import { randomUUID } from 'node:crypto'
import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync
} from 'node:fs'
import { join } from 'node:path'
import { CONVERSATION_SCHEMA_VERSION } from '@shared/agent'
import type {
  AgentEvent,
  ChatMessage,
  Conversation,
  ConversationError,
  ConversationMeta,
  ConversationUsage,
  ConversationWorktree
} from '@shared/agent'
import { forkConversationData, type ImportedConversation } from '@shared/conversation-io'
import { buildScorecard, type Scorecard } from '@shared/scorecard'
import { clearConversationOverride } from './agent/overrides'
import { redactSecrets } from './agent/redact'
import { getUserDataDir } from './userData'

/** Conversations persisted one-JSON-file-per-conversation under userData/conversations. */

function dir(): string {
  const d = join(getUserDataDir(), 'conversations')
  mkdirSync(d, { recursive: true })
  return d
}

function filePath(id: string): string {
  return join(dir(), `${id}.json`)
}

/**
 * Store-issued conversation ids are always randomUUID()s, so anything else is
 * "no such conversation" — checked BEFORE an id becomes a filename. This closes
 * the renderer-IPC → filePath() traversal path (a `../`-laden id escaping the
 * conversations dir) for every filesystem primitive keyed by id — read, delete,
 * and the quarantine rename — at the two entry points that accept ids. It also
 * means a hand-placed non-UUID-named .json file in the directory is ignored by
 * the list/search/scorecard scans rather than parsed (Houston never writes such
 * files, and ignoring is safer than quarantine-renaming a file we don't own).
 */
const CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isConversationId(id: string): boolean {
  return CONVERSATION_ID_RE.test(id)
}

/**
 * Minimal structural check on a parsed conversation file: the fields every code
 * path dereferences without guards (title/messages in search and title
 * derivation, model/usage in the scorecard, updatedAt in list sorting). Deliberately
 * shallow beyond messages — optional fields and forward-compatible extras pass
 * through untouched. Not a trust boundary (these are our own files; imports go
 * through validateImportedConversation) — this only keeps one corrupt file from
 * crashing every list/search/scorecard scan.
 */
function isConversationShape(raw: unknown): raw is Conversation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false
  const o = raw as Record<string, unknown>
  if (
    typeof o.id !== 'string' ||
    typeof o.title !== 'string' ||
    typeof o.workspace !== 'string' ||
    typeof o.providerId !== 'string' ||
    typeof o.model !== 'string' ||
    typeof o.createdAt !== 'number' ||
    typeof o.updatedAt !== 'number' ||
    !Array.isArray(o.messages)
  ) {
    return false
  }
  return o.messages.every(
    (m) =>
      typeof m === 'object' &&
      m !== null &&
      typeof (m as Record<string, unknown>).role === 'string' &&
      typeof (m as Record<string, unknown>).content === 'string'
  )
}

/**
 * Upgrade a shape-valid conversation from the version it was written at to the
 * current one, mirroring the settings store's migrate(). Version-gated steps go
 * here as the on-disk format evolves, oldest first, e.g.:
 *   if (fromVersion < 2) { ...rewrite v1 fields... }
 * v1 is the first stamped version; unversioned legacy files (fromVersion 0) are
 * shape-identical to v1, so today the only change is stamping the version.
 */
function migrate(conv: Conversation): Conversation {
  return { ...conv, schemaVersion: CONVERSATION_SCHEMA_VERSION }
}

/**
 * Move an unreadable conversation file aside as `<id>.json.corrupt` instead of
 * silently dropping it from the list: the chat visibly disappears either way, but
 * the bytes survive for manual recovery, the store stops re-parsing the file on
 * every scan, and the rename is logged. Never throws — quarantine failure just
 * leaves the file in place to be skipped again.
 */
function quarantine(path: string, reason: string): void {
  try {
    renameSync(path, `${path}.corrupt`)
    console.error(`[conversations] quarantined ${path} -> ${path}.corrupt (${reason})`)
  } catch (e) {
    console.error(
      `[conversations] failed to quarantine ${path} (${reason}):`,
      (e as Error)?.message ?? e
    )
  }
}

function read(id: string): Conversation | null {
  if (!isConversationId(id)) return null
  const path = filePath(id)
  if (!existsSync(path)) return null
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    quarantine(path, 'invalid JSON')
    return null
  }
  if (!isConversationShape(raw)) {
    quarantine(path, 'not a conversation shape')
    return null
  }
  return migrate(raw)
}

function write(conv: Conversation): void {
  const path = filePath(conv.id)
  const tmp = `${path}.tmp`
  // Stamp on every write, whatever the call path, so a file read as legacy (v0)
  // converges to the current version the first time it's touched.
  const toWrite: Conversation = { ...conv, schemaVersion: CONVERSATION_SCHEMA_VERSION }
  // 0600 — owner read/write only. Transcripts can capture secrets echoed in tool
  // output (a curl with an auth header, an env dump), so keep them off world-read.
  writeFileSync(tmp, JSON.stringify(toWrite, null, 2), { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, path)
}

export function createConversation(input: {
  workspace: string
  providerId: string
  model: string
  /** When set, the chat runs in this Houston-created git worktree. */
  worktree?: ConversationWorktree
}): Conversation {
  const now = Date.now()
  const conv: Conversation = {
    id: randomUUID(),
    schemaVersion: CONVERSATION_SCHEMA_VERSION,
    title: 'New chat',
    workspace: input.workspace,
    providerId: input.providerId,
    model: input.model,
    createdAt: now,
    updatedAt: now,
    messages: [],
    ...(input.worktree ? { worktree: input.worktree } : {})
  }
  write(conv)
  return conv
}

export function getConversation(id: string): Conversation | null {
  return read(id)
}

/**
 * Duplicate a conversation into a new one with a fresh id, a "(fork)" title, and a
 * copy of the full message log — so the user can branch off and explore a
 * different direction without disturbing the original. Returns the new
 * conversation, or null if the source doesn't exist.
 */
export function forkConversation(id: string): Conversation | null {
  const src = read(id)
  if (!src) return null
  const fork = forkConversationData(src, randomUUID(), Date.now())
  // The "(fork)" title is intentional — leave it be rather than re-summarizing.
  fork.titleGenerated = true
  write(fork)
  return fork
}

/**
 * Create a new conversation from imported data. A fresh id and timestamps are
 * generated. `workspace` is taken from the caller's resolved value — NOT from the
 * file — so an import can't silently set the sandbox's writable scope (the caller
 * resolves it via resolveImportWorkspace). providerId/model fall back to the
 * caller's defaults when the import omits them (they're labels, not a trust
 * boundary — an unknown provider just surfaces an error on the next run).
 */
export function importConversation(
  data: ImportedConversation,
  resolved: { workspace: string; providerId: string; model: string }
): Conversation {
  const now = Date.now()
  const conv: Conversation = {
    id: randomUUID(),
    schemaVersion: CONVERSATION_SCHEMA_VERSION,
    title: data.title,
    workspace: resolved.workspace,
    providerId: data.providerId ?? resolved.providerId,
    model: data.model ?? resolved.model,
    createdAt: now,
    updatedAt: now,
    messages: data.messages,
    // The import carries its own title — don't re-summarize over it.
    titleGenerated: true
  }
  write(conv)
  return conv
}

export function listConversations(): ConversationMeta[] {
  const files = readdirSync(dir()).filter((f) => f.endsWith('.json'))
  const metas: ConversationMeta[] = []
  for (const f of files) {
    const conv = read(f.replace(/\.json$/, ''))
    if (conv) {
      metas.push(toMeta(conv))
    }
  }
  return metas.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * Aggregate a per-model "loop scorecard" over EVERY persisted conversation,
 * entirely on-device. Reads each conversation JSON from userData/conversations,
 * feeds only the model id, cumulative usage totals, message log, and errored flag
 * into the pure {@link buildScorecard} aggregator, and returns the result.
 *
 * STRICT PRIVACY: this is a local-only scan — it never transmits anything, makes
 * no network calls, and reads no data beyond the user's own conversation files.
 * The heavy scan (one file read per conversation) lives here in the main process,
 * off the render path, exposed to the renderer via a single request/response IPC
 * call rather than recomputed on every event.
 */
export function computeScorecard(): Scorecard {
  const files = readdirSync(dir()).filter((f) => f.endsWith('.json'))
  const inputs = []
  for (const f of files) {
    const conv = read(f.replace(/\.json$/, ''))
    if (!conv) continue
    inputs.push({
      model: conv.model,
      messages: conv.messages,
      usage: conv.usage,
      // A stored `lastError` means the most recent run failed — the same signal
      // toMeta() folds into the lightweight `errored` flag.
      errored: !!conv.lastError
    })
  }
  return buildScorecard(inputs)
}

/**
 * Strip the full message log (and the verbose `lastError`) from a stored
 * conversation, leaving the lightweight metadata the sidebar and lists consume.
 * `errored` carries the failed-run flag forward without the message payload.
 */
function toMeta(conv: Conversation): ConversationMeta {
  // schemaVersion is a storage detail — keep it out of the UI list payload.
  const { messages: _messages, lastError, schemaVersion: _schemaVersion, ...rest } = conv
  return { ...rest, errored: !!lastError }
}

export function deleteConversation(id: string): void {
  if (!isConversationId(id)) return
  const path = filePath(id)
  if (existsSync(path)) rmSync(path)
  // Drop any in-memory "Allow for run" consent so a future conversation can't inherit it.
  clearConversationOverride(id)
}

/** Whether a conversation matches a (lowercased) query in its title or any message text. Pure. */
export function conversationMatches(conv: Conversation, queryLower: string): boolean {
  if (conv.title.toLowerCase().includes(queryLower)) return true
  return conv.messages.some((m) => m.content.toLowerCase().includes(queryLower))
}

/** Find conversations whose title or message content matches the query (newest first). */
export function searchConversations(query: string): ConversationMeta[] {
  const q = query.trim().toLowerCase()
  if (!q) return listConversations()
  const files = readdirSync(dir()).filter((f) => f.endsWith('.json'))
  const metas: ConversationMeta[] = []
  for (const f of files) {
    const conv = read(f.replace(/\.json$/, ''))
    if (conv && conversationMatches(conv, q)) {
      metas.push(toMeta(conv))
    }
  }
  return metas.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * Injected source of this install's stored secret values for title redaction. Empty
 * until the app wires it at startup (desktop: wireAgentHost; CLI: the CLI host), which
 * keeps the electron-bound secret store out of the standalone CLI's module graph — this
 * module is reachable from the CLI (via drain → setMessages), and importing `./secrets`
 * would pull in `electron` and fail the CLI bundle's boundary check. Unwired (and in
 * tests) it's `[]`, so pattern redaction still applies; only the exact-known-value layer
 * needs it.
 */
let titleSecretValues: () => string[] = () => []

/** Bind the known-secret source used to redact derived titles. Call once at startup. */
export function configureTitleRedaction(collect: () => string[]): void {
  titleSecretValues = collect
}

/** Derive a placeholder title from the first user message (shown until the model
 * writes a summarized one — see {@link needsGeneratedTitle}). */
export function deriveTitle(messages: ChatMessage[]): string | null {
  const first = messages.find((m) => m.role === 'user')
  if (!first) return null
  // The title is persisted and shown in the sidebar, so a secret pasted into the first
  // message would otherwise leak there even after the message body is redacted. Reuse
  // the same redactor; ordinary prose is untouched. This is the one seam every client's
  // title derivation passes through (setMessages), including runs the loop hasn't
  // touched yet (ipc.ts derives the title from the raw message before the run starts).
  const content = redactSecrets(first.content, titleSecretValues())
  const text = content.trim().replace(/\s+/g, ' ')
  return text.length > 60 ? `${text.slice(0, 57)}…` : text || null
}

/**
 * Whether a conversation is eligible for a model-generated title: it has a user
 * message to summarize, the user hasn't given it a custom title, and one hasn't
 * already been generated. Pure so it's unit-testable without the store.
 */
export function needsGeneratedTitle(conv: Conversation): boolean {
  if (conv.titleCustom || conv.titleGenerated) return false
  return conv.messages.some((m) => m.role === 'user')
}

/**
 * Persist a model-generated title, returning whether it actually took. Re-checks
 * eligibility against the freshly-read conversation so a manual rename that landed
 * while the title was generating still wins. Does NOT bump `updatedAt` — a title
 * arriving a beat after the turn shouldn't reorder the sidebar.
 */
export function setGeneratedTitle(id: string, title: string): boolean {
  const conv = read(id)
  if (!conv || !needsGeneratedTitle(conv)) return false
  conv.title = title
  conv.titleGenerated = true
  write(conv)
  return true
}

/**
 * Fold one turn's token usage into the conversation's persisted totals and return
 * the new cumulative usage. `inputTokens` tracks the latest turn (current context
 * size); `outputTokens` accumulates across every turn. Does not touch `updatedAt`
 * (it's a side-channel of the active run, not new activity).
 */
export function addUsage(
  id: string,
  turn: { inputTokens: number; outputTokens: number; cost: number }
): ConversationUsage | null {
  const conv = read(id)
  if (!conv) return null
  const prev = conv.usage ?? { inputTokens: 0, outputTokens: 0, cost: 0 }
  conv.usage = {
    inputTokens: turn.inputTokens || prev.inputTokens,
    outputTokens: prev.outputTokens + (turn.outputTokens || 0),
    cost: (prev.cost ?? 0) + (turn.cost || 0)
  }
  write(conv)
  return conv.usage
}

/**
 * Rewrite a usage event to carry the conversation's running cumulative totals
 * (the agent loop reports only the latest turn). Pure: non-usage events and a
 * null total pass through unchanged. Kept separate from the store write so the
 * "send the running total, not the turn's own numbers" rule is unit-testable —
 * every field (including `cost`) must be carried, or the meter drifts.
 */
export function mergeRunningTotals(e: AgentEvent, total: ConversationUsage | null): AgentEvent {
  if (e.type !== 'usage' || !total) return e
  return { ...e, inputTokens: total.inputTokens, outputTokens: total.outputTokens, cost: total.cost }
}

/**
 * Persist (or clear) the error that ended the conversation's most recent run, so
 * the "last turn failed" banner and its Retry button survive a reload. Pass `null`
 * to clear. Skips the write when nothing changes, and never bumps `updatedAt` — the
 * failed turn already did so via {@link setMessages}, and clearing the flag on the
 * next run shouldn't reorder the sidebar.
 */
export function setConversationError(id: string, error: ConversationError | null): void {
  const conv = read(id)
  if (!conv) return
  if (error) {
    if (conv.lastError?.message === error.message) return
    conv.lastError = error
  } else {
    if (conv.lastError === undefined) return
    delete conv.lastError
  }
  write(conv)
}

/** Replace the message log for a conversation and bump updatedAt. */
export function setMessages(id: string, messages: ChatMessage[]): void {
  const conv = read(id)
  if (!conv) return
  conv.messages = messages
  conv.updatedAt = Date.now()
  if (conv.title === 'New chat') {
    const title = deriveTitle(messages)
    if (title) conv.title = title
  }
  write(conv)
}

export function updateConversationMeta(
  id: string,
  patch: Partial<Pick<ConversationMeta, 'providerId' | 'model' | 'title'>>
): void {
  const conv = read(id)
  if (!conv) return
  Object.assign(conv, patch)
  conv.updatedAt = Date.now()
  write(conv)
}

/**
 * Apply a user-driven organization change (rename, pin, move to/clear group). Unlike
 * {@link updateConversationMeta} this does NOT bump `updatedAt`, so pinning or filing a
 * chat doesn't reorder it to the top of the recency list. `groupId: null` clears it.
 */
export function organizeConversation(
  id: string,
  patch: { title?: string; pinned?: boolean; archived?: boolean; groupId?: string | null }
): void {
  const conv = read(id)
  if (!conv) return
  if (typeof patch.title === 'string' && patch.title.trim()) {
    conv.title = patch.title.trim()
    // A deliberate rename is sacred: never auto-title over it.
    conv.titleCustom = true
  }
  // Moving between sections (pin / archive / group) invalidates the manual sort
  // position, which is only meaningful within a single section. Drop it so the
  // chat falls back to recency until reordered in its new home.
  const changesSection =
    typeof patch.pinned === 'boolean' ||
    typeof patch.archived === 'boolean' ||
    patch.groupId !== undefined
  if (changesSection) delete conv.order
  if (typeof patch.pinned === 'boolean') conv.pinned = patch.pinned
  if (typeof patch.archived === 'boolean') {
    if (patch.archived) conv.archived = true
    // Drop the flag entirely when unarchiving so it doesn't linger as `false`.
    else delete conv.archived
  }
  if (patch.groupId !== undefined) {
    if (patch.groupId === null) delete conv.groupId
    else conv.groupId = patch.groupId
  }
  write(conv)
}

/**
 * Persist a drag-to-reorder within a sidebar section. `orderedIds` is the
 * section's chats in their new top-to-bottom order; each is stamped with its
 * index as `order`. When the drag also crossed sections, `move` carries the
 * dragged chat's new group (`null` = ungrouped). Like {@link organizeConversation}
 * this never bumps `updatedAt`, so reordering doesn't disturb recency elsewhere.
 */
export function reorderConversations(
  orderedIds: string[],
  move?: { id: string; groupId: string | null }
): void {
  orderedIds.forEach((id, index) => {
    const conv = read(id)
    if (!conv) return
    let changed = false
    if (conv.order !== index) {
      conv.order = index
      changed = true
    }
    if (move && move.id === id) {
      if (move.groupId === null) {
        if (conv.groupId !== undefined) {
          delete conv.groupId
          changed = true
        }
      } else if (conv.groupId !== move.groupId) {
        conv.groupId = move.groupId
        changed = true
      }
    }
    if (changed) write(conv)
  })
}
