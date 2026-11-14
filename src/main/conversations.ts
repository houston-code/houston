import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { writeFileAtomicStampedSync } from './atomic-write'
import { buildUsageReport, type UsageInput, type UsageReport } from '@shared/usageReport'
import { externalizeMedia, hydrateMedia, pruneMedia, readMediaFile, viewMedia } from './conversationMedia'
import { parseMediaUrl, type ImageAttachment } from '@shared/images'
import {
  COMPACTION_SUMMARY_PREFIX,
  CONVERSATION_SCHEMA_VERSION,
  SYSTEM_NOTE_PREFIX,
  isReasoningEffort
} from '@shared/agent'
import { ASK_USER_TOOL } from '@shared/constants'
import { isApprovalPolicy, type ApprovalPolicy } from '@shared/types'
import type {
  AgentEvent,
  ChatMessage,
  ChildReport,
  Conversation,
  ConversationCompaction,
  ConversationError,
  ConversationMeta,
  ConversationSettingsPatch,
  ContextParts,
  ConversationUsage,
  ConversationWorktree,
  PromptSnapshot,
  RewindBackup,
  ProposalState,
  ReasoningEffort,
  SpawnedFrom,
  StoredSideChat
} from '@shared/agent'
import { forkConversationData, type ForkPoint, type ImportedConversation } from '@shared/conversation-io'
import { replyMessageIndexes } from '@shared/chatStatus'
import { rewindableTurnIndices, turnText } from '@shared/rewind'
import { repairDanglingToolResults } from './agent/repair'
import { accumulateModelUsage } from '@shared/usage'
import { invocationText } from '@shared/promptInvocation'
import { runOutcome, type RunOutcome } from '@shared/runEnd'
import { buildScorecard, type Scorecard } from '@shared/scorecard'
import type { StoredQueue } from '@shared/queue'
import { clearConversationOverride } from './agent/overrides'
import { forgetSubAgentSessions } from './agent/subagentSessions'
import { redactSecrets } from './agent/redact'
import { getUserDataDir } from './userData'
import { log } from './logger'

/** Conversations persisted one-JSON-file-per-conversation under userData/conversations. */

function dir(): string {
  const d = join(getUserDataDir(), 'conversations')
  mkdirSync(d, { recursive: true })
  return d
}

function filePath(id: string): string {
  return join(dir(), `${id}.json`)
}

/** Where a conversation's saved transcript lives (the file may not exist yet). */
export function conversationFilePath(id: string): string {
  return filePath(id)
}

/** Where a conversation's attachment bytes live (see conversationMedia.ts). */
function mediaDir(id: string): string {
  return join(dir(), `${id}.media`)
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
 * shape-identical to v1. v2 moved attachment bytes into the media folder; a v0/v1
 * file's inline attachments are still valid in memory and are externalized by the
 * next write(), so no step is needed here either. Today the only change is stamping
 * the version.
 */
function migrate(conv: Conversation): Conversation {
  return dropUnknownChatSettings({ ...conv, schemaVersion: stampedVersion(conv.schemaVersion) })
}

/**
 * Drop a stored reasoning effort or approval policy that isn't on its list (a
 * hand-edited file, or one a newer Houston wrote), so the chat falls back to the
 * defaults. Never coerced to some other value: an unknown policy fails open
 * downstream, and the default is what an unset field means everywhere else.
 */
function dropUnknownChatSettings(conv: Conversation): Conversation {
  if (conv.reasoningEffort !== undefined && !isReasoningEffort(conv.reasoningEffort)) delete conv.reasoningEffort
  if (conv.approvalPolicy !== undefined && !isApprovalPolicy(conv.approvalPolicy)) delete conv.approvalPolicy
  if (conv.announcedPolicy !== undefined && !isApprovalPolicy(conv.announcedPolicy)) delete conv.announcedPolicy
  return conv
}

/**
 * This build's schema version, or the higher one a newer Houston already stamped on the
 * file. Writing the lower number after a downgrade would make the next upgrade re-run
 * migrations the file has already been through.
 */
function stampedVersion(onDisk: number | undefined): number {
  return Math.max(CONVERSATION_SCHEMA_VERSION, typeof onDisk === 'number' ? onDisk : 0)
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
    log.warn(`[conversations] quarantined ${path} -> ${path}.corrupt (${reason})`)
  } catch (e) {
    log.error(`[conversations] failed to quarantine ${path} (${reason}): ${(e as Error)?.message ?? String(e)}`)
  }
}

function read(id: string): Conversation | null {
  if (!isConversationId(id)) return null
  const path = filePath(id)
  if (!existsSync(path)) return null
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    // Can't read it right now (EACCES after a sudo run, Windows EBUSY/EPERM while
    // antivirus or another process holds it, EMFILE): the bytes may be fine, so skip
    // the chat this time rather than quarantining it for good.
    log.warn(`[conversations] could not read ${path}: ${(e as Error)?.message ?? String(e)}`)
    return null
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
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

/** A conversation without its message log: everything a bookkeeping change touches. */
type ConversationShell = Omit<Conversation, 'messages'>

/**
 * What this process last wrote for a chat, kept so the next save does not have to read
 * the file back and parse it. Saving used to be read, parse, change one field,
 * serialise everything, write: several times per model step, on the main thread, each
 * pass linear in the size of the chat. With this:
 *
 * - a bookkeeping change (usage totals, compaction state, the failed-turn marker)
 *   reuses the message log's JSON text as written last time, so the messages are
 *   neither parsed nor serialised again;
 * - replacing the message log needs only the rest of the conversation, so the file is
 *   not read at all.
 *
 * An entry is used only while the file on disk is still the one this process wrote:
 * its stamp (inode, mtime, size) is taken from the temp file before the rename and
 * compared with a fresh stat before every use. Another process's write (the terminal
 * client, a headless run) replaces the file, the stamps differ, and the save falls
 * back to reading it, exactly as before. `shell` is this module's own copy, never
 * shared with a caller.
 */
interface WrittenChat {
  stamp: string
  shell: ConversationShell
  messagesJson: string
}
const written = new Map<string, WrittenChat>()
/** Chats remembered at once. Each holds its message log as text, so keep it to the few in use. */
const MAX_WRITTEN_CHATS = 4

function rememberWritten(id: string, entry: WrittenChat): void {
  written.delete(id)
  written.set(id, entry)
  for (const oldest of written.keys()) {
    if (written.size <= MAX_WRITTEN_CHATS) break
    written.delete(oldest)
  }
}

/** The remembered write for `id`, if the file on disk is still that write. */
function stillWritten(id: string): WrittenChat | null {
  const entry = written.get(id)
  if (!entry) return null
  if (fileStamp(filePath(id)) !== entry.stamp) {
    written.delete(id)
    return null
  }
  return entry
}

/** For tests: forget what this process last wrote, so every save reads the file. */
export function resetConversationWriteCache(): void {
  written.clear()
}

/** The file's text: the shell's fields, then the message log. */
function serialize(shell: ConversationShell, messagesJson: string): string {
  // A shell always has fields (id, title, ...), so its JSON ends in a value then "}".
  return `${JSON.stringify(shell).slice(0, -1)},"messages":${messagesJson}}`
}

/** Put `shell` + `messagesJson` on disk and remember them as this process's write. */
function commit(id: string, shell: ConversationShell, messagesJson: string): void {
  // 0600 — owner read/write only. Transcripts can capture secrets echoed in tool
  // output (a curl with an auth header, an env dump), so keep them off world-read.
  // Compact, not indented: nobody reads these by hand, every reader parses either form,
  // and indentation more than doubled a chat full of nested subagent records.
  // Not fsynced: a chat is saved several times per model step on the main thread, and
  // an fsync each time (a few ms, more under disk contention) would stall it. A file a
  // power loss truncates fails to parse and is quarantined with its bytes, not dropped.
  const stamp = writeFileAtomicStampedSync(filePath(id), serialize(shell, messagesJson), 0o600, {
    durable: false
  })
  rememberWritten(id, { stamp, shell: structuredClone(shell), messagesJson })
  // This process's own write: drop the cached metadata now rather than lean on the
  // file's stamp, which a filesystem with coarse timestamps could repeat.
  metaCache.delete(id)
  dropSearchEntry(id)
}

function write(conv: Conversation): void {
  // Stamp on every write, whatever the call path, so a file read as legacy (v0)
  // converges to the current version the first time it's touched (and a file stamped by
  // a newer Houston keeps its higher version).
  const stamped: Conversation = { ...conv, schemaVersion: stampedVersion(conv.schemaVersion) }
  // Attachment bytes go to the media folder first, so the JSON never names a file
  // that isn't there yet; files no longer referenced are dropped after it lands.
  const media = mediaDir(conv.id)
  const { value: toWrite, refs } = externalizeMedia(stamped, media)
  const { messages, ...shell } = toWrite
  commit(conv.id, shell, JSON.stringify(messages))
  pruneMedia(media, refs)
}

/**
 * Open a chat for a change that does not touch its message log. `conv` is the caller's
 * to edit; `save` writes it. Uses the remembered write when the file is still ours (no
 * read, no parse, and the messages are not serialised again), and the file otherwise.
 * Only for fields that hold no attachments: `save` on the fast path does not
 * externalize or prune media, and has no need to, since the log is untouched.
 */
function openForBookkeeping(id: string): { conv: ConversationShell; save: () => void } | null {
  if (!isConversationId(id)) return null
  const ours = stillWritten(id)
  if (ours) {
    const shell = structuredClone(ours.shell)
    return {
      conv: shell,
      save: () => commit(id, { ...shell, schemaVersion: stampedVersion(shell.schemaVersion) }, ours.messagesJson)
    }
  }
  const conv = read(id)
  return conv ? { conv, save: () => write(conv) } : null
}

export function createConversation(input: {
  workspace: string
  providerId: string
  model: string
  /** The chat's own settings; unset ones fall back to the defaults. */
  reasoningEffort?: ReasoningEffort
  approvalPolicy?: ApprovalPolicy
  /** When set, the chat runs in this Houston-created git worktree. */
  worktree?: ConversationWorktree
  /** When set, the chat was spawned by another chat (see `spawn_session`). */
  spawnedFrom?: SpawnedFrom
}): Conversation {
  const now = Date.now()
  const conv: Conversation = {
    id: randomUUID(),
    schemaVersion: CONVERSATION_SCHEMA_VERSION,
    title: 'New chat',
    workspace: input.workspace,
    providerId: input.providerId,
    model: input.model,
    ...(isReasoningEffort(input.reasoningEffort) ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(isApprovalPolicy(input.approvalPolicy) ? { approvalPolicy: input.approvalPolicy } : {}),
    createdAt: now,
    updatedAt: now,
    messages: [],
    ...(input.worktree ? { worktree: input.worktree } : {}),
    ...(input.spawnedFrom ? { spawnedFrom: input.spawnedFrom } : {})
  }
  write(conv)
  return conv
}

/**
 * A conversation ready to use: attachments carry their bytes again. The internal
 * read() leaves them as media references, which is all the read-modify-write
 * helpers below need (write() keeps references as they are), so only callers that
 * hand messages to a provider, the renderer, or an export pay for loading images.
 */
export function getConversation(id: string): Conversation | null {
  const conv = read(id)
  if (!conv) return null
  // The rewind backup is the store's own undo state (see agent/rewind.ts), read with
  // peekConversation. Left out here, it can't reach an export, the renderer, or a
  // provider: it holds the messages the user rewound away, attachments and all.
  const { rewindBackup: _rewindBackup, ...rest } = conv
  return hydrateMedia(rest, mediaDir(conv.id))
}

/**
 * {@link getConversation} for the app window: images come as URLs to their stored
 * files and documents without their bytes (see viewMedia), so opening a chat full of
 * screenshots does not copy every one into the window as base64.
 */
export function getConversationForView(id: string): Conversation | null {
  const conv = read(id)
  if (!conv) return null
  const { rewindBackup: _rewindBackup, ...rest } = conv
  return viewMedia(rest, mediaDir(conv.id), conv.id)
}

/** {@link viewMedia} for a conversation some other call already loaded (a fork, a compaction). */
export function conversationForView<T>(value: T, conversationId: string): T {
  return isConversationId(conversationId) ? viewMedia(value, mediaDir(conversationId), conversationId) : value
}

const IMAGE_TYPE_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp'
}

/**
 * The stored image a {@link mediaUrl} names, as bytes, or null when the URL is not
 * one, names no conversation, or the file is gone or not an image. The type comes
 * from the stored file's name, never from the caller.
 */
export function readStoredImage(url: unknown): { mediaType: string; bytes: Buffer } | null {
  const parsed = parseMediaUrl(url)
  if (!parsed) return null
  const mediaType = IMAGE_TYPE_BY_EXT[parsed.mediaRef.slice(parsed.mediaRef.lastIndexOf('.') + 1)]
  if (!mediaType) return null
  const bytes = readMediaFile(mediaDir(parsed.conversationId), parsed.mediaRef)
  return bytes ? { mediaType, bytes } : null
}

/**
 * Images the window sends back (a past message's images restored to the composer
 * and sent again): any that name a stored file by URL get their bytes back, so the
 * provider receives the image itself. Anything else passes through untouched for
 * sanitizeAttachments to check; an unresolvable URL keeps its empty `data` and is
 * dropped there.
 */
export function resolveStoredImages(value: unknown): unknown {
  if (!Array.isArray(value)) return value
  return value.map((v) => {
    if (typeof v !== 'object' || v === null) return v
    const { src, data } = v as Partial<ImageAttachment>
    if (typeof src !== 'string' || (typeof data === 'string' && data.length > 0)) return v
    const stored = readStoredImage(src)
    return stored ? { mediaType: stored.mediaType, data: stored.bytes.toString('base64') } : v
  })
}

/**
 * A conversation for reading its metadata (title, workspace, prompt snapshot,
 * compaction state) without loading any attachment bytes: images stay as media
 * references. Never hand the result to a provider or back to the store.
 */
export function peekConversation(id: string): Conversation | null {
  return read(id)
}

/** Whether a conversation's file exists, without reading it. */
export function conversationExists(id: string): boolean {
  return isConversationId(id) && existsSync(filePath(id))
}

/**
 * Duplicate a conversation into a new one with a fresh id, a "(fork)" title, and a
 * copy of the full message log — so the user can branch off and explore a
 * different direction without disturbing the original. Returns the new
 * conversation, or null if the source doesn't exist.
 */
/**
 * How many leading messages a fork from `point` keeps, or null when the point no
 * longer names a message in `messages`. After a reply, that reply's tool results come
 * along (a call without its results can't be sent); before a user message, nothing of
 * that message or after it.
 */
export function forkCut(messages: ChatMessage[], point: ForkPoint): number | null {
  if (point.kind === 'reply') {
    const at = replyMessageIndexes(messages)[point.n]
    if (at === undefined) return null
    let cut = at + 1
    while (messages[cut]?.role === 'tool') cut++
    return cut
  }
  const at = rewindableTurnIndices(messages)[point.n]
  if (at === undefined || turnText(messages[at]) !== point.text) return null
  return at
}

/**
 * Fork a chat from one of its messages: a new chat holding the conversation up to
 * that point (see {@link forkCut}), made like a whole-chat fork. Null when the chat or
 * the point is gone.
 */
export function forkConversationAt(id: string, point: ForkPoint): Conversation | null {
  const src = getConversation(id)
  if (!src) return null
  const cut = forkCut(src.messages, point)
  if (cut === null) return null
  // Anything left unbalanced by the cut is closed off, as a hand-off's history is.
  const messages = repairDanglingToolResults(src.messages.slice(0, cut))
  const fork = forkConversationData({ ...src, messages }, randomUUID(), Date.now())
  fork.titleGenerated = true
  write(fork)
  return fork
}

export function forkConversation(id: string): Conversation | null {
  // Hydrated: the fork's write() copies the bytes into the fork's own media folder.
  const src = getConversation(id)
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

/**
 * Each chat's list metadata, as of the file it was last read from. Listing used to read
 * and parse every chat in full (megabytes of messages each) to return a few fields, on
 * the main thread, several times a turn; with this, a list is one directory read, one
 * stat per chat, and a parse of only the chats whose file changed.
 *
 * An entry is trusted only while its file's stamp (inode, mtime, size) is unchanged.
 * Every writer, in this process or another (the terminal client, a headless run),
 * replaces the file by rename, which changes the inode, so a write anywhere is seen on
 * the next list without any other signal.
 */
const metaCache = new Map<string, { stamp: string; meta: ConversationMeta }>()

/** A chat file's identity on disk, or null when it is gone. */
function fileStamp(path: string): string | null {
  try {
    const st = statSync(path)
    return `${st.ino}:${st.mtimeMs}:${st.size}`
  } catch {
    return null
  }
}

/** For tests: forget every cached chat's metadata. */
export function resetConversationListCache(): void {
  metaCache.clear()
}

export function listConversations(): ConversationMeta[] {
  const files = readdirSync(dir()).filter((f) => f.endsWith('.json'))
  const metas: ConversationMeta[] = []
  const seen = new Set<string>()
  for (const f of files) {
    const id = f.replace(/\.json$/, '')
    if (!isConversationId(id)) continue
    // Stamp first, read second: if the file is replaced in between, the entry holds
    // newer metadata under an older stamp and is simply read again next time.
    const stamp = fileStamp(filePath(id))
    if (stamp === null) continue
    seen.add(id)
    const cached = metaCache.get(id)
    if (cached && cached.stamp === stamp) {
      metas.push({ ...cached.meta })
      continue
    }
    const conv = read(id)
    if (!conv) {
      metaCache.delete(id)
      continue
    }
    const meta = toMeta(conv)
    metaCache.set(id, { stamp, meta })
    metas.push({ ...meta })
  }
  // Chats deleted since the last list (here or by another process).
  for (const id of metaCache.keys()) if (!seen.has(id)) metaCache.delete(id)
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
      // A fork's (or a forked-context spawn's) copied history is its source's work.
      inherited: inheritedMessages(conv),
      usage: conv.usage,
      // A stored `lastError` means the most recent run failed — the same signal
      // toMeta() folds into the lightweight `errored` flag.
      errored: !!conv.lastError
    })
  }
  return buildScorecard(inputs)
}

/**
 * Spend and tokens per day and per project over every saved chat, for the usage
 * view. Local only, like {@link computeScorecard}: it reads the user's own chat files
 * in the main process and hands back only the sums, never message text.
 */
export function computeUsageReport(now: Date = new Date()): UsageReport {
  const files = readdirSync(dir()).filter((f) => f.endsWith('.json'))
  const inputs: UsageInput[] = []
  for (const f of files) {
    const conv = read(f.replace(/\.json$/, ''))
    if (!conv) continue
    inputs.push({
      project: conv.worktree?.repoRoot || conv.workspace,
      messages: conv.messages,
      inherited: inheritedMessages(conv),
      ...(conv.usage ? { usage: conv.usage } : {})
    })
  }
  return buildUsageReport(inputs, now)
}

/** How many messages at the start of `conv`'s log were copied from another chat. */
function inheritedMessages(conv: Conversation): number {
  const n = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0)
  return Math.max(n(conv.forkedFrom?.historyLength), n(conv.spawnedFrom?.historyLength))
}

/**
 * Strip the full message log (and the verbose `lastError`) from a stored
 * conversation, leaving the lightweight metadata the sidebar and lists consume.
 * `errored` carries the failed-run flag forward without the message payload.
 */
function toMeta(conv: Conversation): ConversationMeta {
  // schemaVersion is a storage detail, and compaction carries a summary that can
  // run to kilobytes — keep both out of the UI list payload. Queued input is read
  // through the queue's own channel (agentQueueList), never the list.
  const {
    messages: _messages,
    lastError,
    schemaVersion: _schemaVersion,
    compaction: _compaction,
    promptSnapshot: _promptSnapshot,
    announcedPolicy: _announcedPolicy,
    proposals: _proposals,
    childReports: _childReports,
    sideChat: _sideChat,
    rewindBackup: _rewindBackup,
    queuedInput: _queuedInput,
    forkedFrom: _forkedFrom,
    ...rest
  } = conv
  return { ...rest, errored: !!lastError }
}

/**
 * How many conversations other than `exceptId` run in the worktree at `path`. A fork
 * carries its source's worktree, so two chats can share one, and tearing it down with
 * one of them would pull the checkout out from under the other.
 */
export function otherConversationsInWorktree(exceptId: string, path: string): number {
  return listConversations().filter((c) => c.id !== exceptId && c.worktree?.path === path).length
}

export function deleteConversation(id: string): void {
  if (!isConversationId(id)) return
  const path = filePath(id)
  if (existsSync(path)) rmSync(path)
  metaCache.delete(id)
  written.delete(id)
  dropSearchEntry(id)
  rmSync(mediaDir(id), { recursive: true, force: true })
  // Drop any in-memory "Allow for run" consent so a future conversation can't inherit it.
  clearConversationOverride(id)
  // And its resumable subagent transcripts, which nothing can reach any more.
  forgetSubAgentSessions(id)
}

/**
 * Whether a conversation matches a (lowercased) query in its title, the folder and
 * branch the sidebar shows under it, or any message text. Pure.
 */
export function conversationMatches(conv: Conversation, queryLower: string): boolean {
  return searchHaystack(conv).some((t) => t.includes(queryLower))
}

/**
 * Everything search compares a query against, lowercased, one string per label or
 * message: kept apart so a query can never match across the boundary of two of them.
 * Pure.
 */
function searchHaystack(conv: Conversation): string[] {
  const labels = [
    conv.title,
    // The sidebar labels a worktree chat by its repo and branch, any other by its folder.
    conv.worktree ? basename(conv.worktree.repoRoot) : basename(conv.workspace),
    conv.worktree?.branch ?? ''
  ]
  const out: string[] = []
  for (const l of labels) if (l) out.push(l.toLowerCase())
  for (const m of conv.messages) {
    const t = searchableText(m)
    if (t) out.push(t.toLowerCase())
  }
  return out
}

/**
 * The text of a message that search looks at: what the transcript shows as written
 * by the user or the assistant. Tool output, tool-call arguments, reasoning, and the
 * notes and summaries Houston injects are left out, so a chat doesn't match on a
 * word that only appeared in a file listing or a grep result. Pure.
 */
export function searchableText(m: ChatMessage): string {
  if (m.role === 'tool') return m.toolName === ASK_USER_TOOL ? m.content : ''
  if (m.role === 'assistant') return m.content
  if (m.content.startsWith(SYSTEM_NOTE_PREFIX) || m.content.startsWith(COMPACTION_SUMMARY_PREFIX)) return ''
  // A prompt Houston wrote for the user (`/review`, a ship button) shows as what they
  // did; a spawned session's brief is the task itself, as with titles (deriveTitle).
  return m.invokedAs && m.invokedAs.kind !== 'spawned' ? invocationText(m.invokedAs) : m.content
}

/** Find conversations whose title or message content matches the query (newest first). */
/**
 * Each chat's search haystack (see {@link searchHaystack}), as of the file it came from.
 * A search used to read and parse every chat in full on the main thread, after each
 * pause in typing and every few seconds while a chat runs. With this, a search is a
 * list (stats only, see {@link listConversations}) and an in-memory scan; only chats
 * whose file changed are read again.
 *
 * Validated by the same file stamp as the metadata cache, so a write from another
 * process is seen on the next search. Since it is the text of every chat, it is held
 * only while the user is searching: it is released {@link SEARCH_CACHE_IDLE_MS} after
 * the last search, and while held it stays under a total size, past which the
 * least recently searched entries go (those chats are read from disk again when next
 * searched).
 */
const searchCache = new Map<string, { stamp: string; haystack: string[]; chars: number }>()
let searchCacheChars = 0
/** Total characters the search cache may hold (lowercased text, mostly one byte each). */
export const MAX_SEARCH_CACHE_CHARS = 32_000_000
let searchCacheBudget = MAX_SEARCH_CACHE_CHARS

/** For tests: a smaller search cache (null restores the default). */
export function _setSearchCacheBudget(chars: number | null): void {
  searchCacheBudget = chars ?? MAX_SEARCH_CACHE_CHARS
}
/** How long after the last search the cache is kept. */
export const SEARCH_CACHE_IDLE_MS = 60_000
let searchCacheTimer: ReturnType<typeof setTimeout> | null = null

/** Release the cache once searching has stopped for {@link SEARCH_CACHE_IDLE_MS}. */
function releaseSearchCacheWhenIdle(): void {
  if (searchCacheTimer) clearTimeout(searchCacheTimer)
  searchCacheTimer = setTimeout(() => {
    searchCacheTimer = null
    resetConversationSearchCache()
  }, SEARCH_CACHE_IDLE_MS)
  // Never keep a terminal client alive just to clear this.
  searchCacheTimer.unref?.()
}

function dropSearchEntry(id: string): void {
  const entry = searchCache.get(id)
  if (!entry) return
  searchCacheChars -= entry.chars
  searchCache.delete(id)
}

/** For tests: forget every cached haystack. */
export function resetConversationSearchCache(): void {
  searchCache.clear()
  searchCacheChars = 0
}

/** A chat's haystack, from the cache when its file is unchanged, else read and cached. */
function haystackFor(id: string, stamp: string): string[] | null {
  const hit = searchCache.get(id)
  if (hit && hit.stamp === stamp) {
    // Most recently searched last, so the oldest is evicted first.
    searchCache.delete(id)
    searchCache.set(id, hit)
    return hit.haystack
  }
  dropSearchEntry(id)
  const conv = read(id)
  if (!conv) return null
  const haystack = searchHaystack(conv)
  const chars = haystack.reduce((n, t) => n + t.length, 0)
  searchCache.set(id, { stamp, haystack, chars })
  searchCacheChars += chars
  for (const oldest of searchCache.keys()) {
    if (searchCacheChars <= searchCacheBudget || oldest === id) break
    dropSearchEntry(oldest)
  }
  return haystack
}

/** Find conversations whose title or message content matches the query (newest first). */
export function searchConversations(query: string): ConversationMeta[] {
  const q = query.trim().toLowerCase()
  if (!q) return listConversations()
  const metas = listConversations()
  const live = new Set<string>()
  const out: ConversationMeta[] = []
  for (const meta of metas) {
    live.add(meta.id)
    // listConversations just stamped every listed chat.
    const stamp = metaCache.get(meta.id)?.stamp
    const haystack = stamp ? haystackFor(meta.id, stamp) : null
    if (haystack?.some((t) => t.includes(q))) out.push(meta)
  }
  // Chats deleted since the last search.
  for (const id of [...searchCache.keys()]) if (!live.has(id)) dropSearchEntry(id)
  releaseSearchCacheWhenIdle()
  return out
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
  // A first-party prompt is titled by what the user did ("/review", "Create PR"), not
  // by the instructions it expanded to. A spawned brief is the task itself, so it
  // keeps titling from its text.
  const source =
    first.invokedAs && first.invokedAs.kind !== 'spawned' ? invocationText(first.invokedAs) : first.content
  const content = redactSecrets(source, titleSecretValues())
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
 * Record the user's decision on a `propose_session` card. Does not bump `updatedAt`:
 * clicking a card shouldn't reorder the sidebar. Returns the chat's full proposal map
 * after the write (empty when the chat doesn't exist).
 */
export function setProposalState(
  id: string,
  callId: string,
  state: ProposalState
): Record<string, ProposalState> {
  const conv = read(id)
  if (!conv) return {}
  conv.proposals = { ...(conv.proposals ?? {}), [callId]: state }
  write(conv)
  return conv.proposals
}

/**
 * How a conversation's latest run ended, from its persisted log (no attachment
 * bytes loaded). Undefined when the chat no longer exists.
 */
export function conversationRunOutcome(id: string): RunOutcome | undefined {
  const conv = read(id)
  return conv ? runOutcome(conv.messages, conv.lastError) : undefined
}

/** Most finished-child reports kept pending on one parent; older ones drop first. */
export const MAX_PENDING_CHILD_REPORTS = 20
/** Longest summary kept per report (the child's own chat holds the full answer). */
export const CHILD_REPORT_SUMMARY_CHARS = 400

/**
 * Build a finished child session's report from its persisted log: its title, how its
 * last run ended (finished, failed, stopped, or hit a limit), and the start of its
 * final answer. Pure, so the truncation and
 * fallback wording are testable without a store.
 */
export function childReportFrom(child: Conversation, now: number): ChildReport {
  const lastAnswer = [...child.messages]
    .reverse()
    .find((m) => m.role === 'assistant' && m.content.trim())
  // How its last run ended comes from the record the run left on its last message
  // (a stop, a limit, an error), not the stored error alone: a stalled or capped run
  // has no error, and reporting it as finished would tell the parent the work is done.
  const end = runOutcome(child.messages, child.lastError)
  const raw =
    end.outcome === 'error'
      ? (end.message ?? 'The run failed.')
      : (lastAnswer?.content ??
        (end.outcome === 'done' ? 'It finished without a written answer.' : 'It stopped without a written answer.'))
  const flat = raw.replace(/\s+/g, ' ').trim()
  const summary =
    flat.length > CHILD_REPORT_SUMMARY_CHARS
      ? `${flat.slice(0, CHILD_REPORT_SUMMARY_CHARS - 1)}…`
      : flat
  return {
    conversationId: child.id,
    title: child.title,
    outcome: end.outcome,
    ...(end.outcome === 'limit' && end.limit ? { limit: end.limit } : {}),
    summary,
    finishedAt: now
  }
}

/**
 * Queue a finished spawned session's report on the chat that spawned it, for the
 * parent's next turn. A no-op when either chat is gone. Does not bump `updatedAt`.
 */
export function reportChildToParent(parentId: string, childId: string): void {
  const parent = read(parentId)
  const child = read(childId)
  if (!parent || !child) return
  const report = childReportFrom(child, Date.now())
  // One report per child: a later run of the same child replaces its earlier report.
  const rest = (parent.childReports ?? []).filter((r) => r.conversationId !== childId)
  parent.childReports = [...rest, report].slice(-MAX_PENDING_CHILD_REPORTS)
  write(parent)
}

/**
 * Replace a chat's stored side chat (null forgets it). Does not bump `updatedAt`: a
 * side question isn't activity in the chat itself, so it mustn't reorder the sidebar.
 */
export function saveSideChat(id: string, sideChat: StoredSideChat | null): void {
  const conv = read(id)
  if (!conv) return
  if (sideChat) conv.sideChat = sideChat
  else if (conv.sideChat === undefined) return
  else delete conv.sideChat
  write(conv)
}

/**
 * A chat's stored input queue, attachments loaded, or null when nothing is queued.
 * Hydrates the queue alone: the message log's media stays on disk.
 */
export function getQueuedInput(id: string): StoredQueue | null {
  const conv = read(id)
  if (!conv?.queuedInput) return null
  return hydrateMedia(conv.queuedInput, mediaDir(id))
}

/**
 * Replace a chat's stored input queue (null clears it). See agent/queue.ts, which
 * owns it. Bookkeeping: never bumps `updatedAt`, so queueing a message mid-run
 * doesn't reorder the sidebar on its own.
 */
export function setQueuedInput(id: string, queue: StoredQueue | null): void {
  const conv = read(id)
  if (!conv) return
  if (queue && queue.items.length) conv.queuedInput = queue
  else if (conv.queuedInput === undefined) return
  else delete conv.queuedInput
  write(conv)
}

/** Take (and clear) a chat's pending finished-child reports. */
export function takeChildReports(id: string): ChildReport[] {
  const conv = read(id)
  const reports = conv?.childReports ?? []
  if (!conv || reports.length === 0) return []
  delete conv.childReports
  write(conv)
  return reports
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
  turn: {
    inputTokens: number
    outputTokens: number
    cost: number
    model?: string
    cacheReadTokens?: number
    cacheWriteTokens?: number
    /** What filled the context on this round's request; a round without it keeps the last. */
    contextParts?: ContextParts
  }
): ConversationUsage | null {
  const open = openForBookkeeping(id)
  if (!open) return null
  const { conv } = open
  const prev = conv.usage ?? { inputTokens: 0, outputTokens: 0, cost: 0 }
  conv.usage = {
    inputTokens: turn.inputTokens || prev.inputTokens,
    outputTokens: prev.outputTokens + (turn.outputTokens || 0),
    cost: (prev.cost ?? 0) + (turn.cost || 0),
    cacheReadTokens: (prev.cacheReadTokens ?? 0) + (turn.cacheReadTokens ?? 0),
    // Per-model tallies via the shared accumulator, so the GUI's persisted
    // breakdown and the TUI's in-memory one agree on what a session cost.
    perModel: accumulateModelUsage(prev.perModel ?? [], turn),
    ...(turn.contextParts ?? prev.contextParts ? { contextParts: turn.contextParts ?? prev.contextParts } : {})
  }
  open.save()
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
  return {
    ...e,
    // The round's own numbers, before they are replaced by the running totals.
    round: { inputTokens: e.inputTokens, outputTokens: e.outputTokens, cost: e.cost },
    inputTokens: total.inputTokens,
    outputTokens: total.outputTokens,
    cost: total.cost,
    // Carry the running cache-read and per-model breakdown too, or the renderer's
    // cost panel drifts the same way the aggregate meter used to.
    ...(total.cacheReadTokens ? { cacheReadTokens: total.cacheReadTokens } : {}),
    ...(total.perModel ? { perModel: total.perModel } : {})
  }
}

/**
 * Persist (or clear) the error that ended the conversation's most recent run, so
 * the "last turn failed" banner and its Retry button survive a reload. Pass `null`
 * to clear. Skips the write when nothing changes, and never bumps `updatedAt` — the
 * failed turn already did so via {@link setMessages}, and clearing the flag on the
 * next run shouldn't reorder the sidebar.
 */
export function setConversationError(id: string, error: ConversationError | null): void {
  const open = openForBookkeeping(id)
  if (!open) return
  const { conv } = open
  if (error) {
    if (conv.lastError?.message === error.message) return
    conv.lastError = error
  } else {
    if (conv.lastError === undefined) return
    delete conv.lastError
  }
  open.save()
}

/**
 * Persist (or clear) the loop's context-compaction state, so the next run resumes
 * from the last summary instead of re-summarizing the same head every turn. Pass
 * `null` when a log rewrite (e.g. `/compact`) invalidates the stored cut. Skips
 * the write when nothing changes and never bumps `updatedAt` — compaction is
 * bookkeeping, not user activity, and shouldn't reorder the sidebar.
 */
export function setCompaction(id: string, compaction: ConversationCompaction | null): void {
  const open = openForBookkeeping(id)
  if (!open) return
  const { conv } = open
  if (compaction) {
    const prev = conv.compaction
    if (
      prev?.cut === compaction.cut &&
      prev.summary === compaction.summary &&
      prev.anchor === compaction.anchor &&
      prev.evictBefore === compaction.evictBefore &&
      JSON.stringify(prev.workspaceState) === JSON.stringify(compaction.workspaceState)
    ) {
      return
    }
    conv.compaction = compaction
  } else {
    if (conv.compaction === undefined) return
    delete conv.compaction
  }
  open.save()
}

/**
 * Persist the system-prompt snapshot (see PromptSnapshot), so later runs, including
 * after an app restart, rebuild a byte-identical prompt. Bookkeeping like
 * compaction: never bumps `updatedAt`.
 */
export function setPromptSnapshot(id: string, snapshot: PromptSnapshot): void {
  const open = openForBookkeeping(id)
  if (!open) return
  open.conv.promptSnapshot = snapshot
  open.save()
}

/**
 * Persist the approval mode the model was last told about (see
 * Conversation.announcedPolicy). Bookkeeping: never bumps `updatedAt`.
 */
export function setAnnouncedPolicy(id: string, policy: ApprovalPolicy): void {
  const open = openForBookkeeping(id)
  if (!open || open.conv.announcedPolicy === policy) return
  open.conv.announcedPolicy = policy
  open.save()
}

/**
 * Replace the message log for a conversation and bump updatedAt. `meta` is applied in
 * the same write, as {@link updateConversationMeta} would: a send records the new user
 * message and the settings it runs under together, and two calls meant reading,
 * serialising and rewriting the whole file twice.
 */
export function setMessages(id: string, messages: ChatMessage[], meta?: ConversationMetaPatch): void {
  // The new log replaces the old one outright, so only the rest of the conversation
  // is needed: taken from this process's last write when the file is still that write,
  // which skips reading and parsing a log that is about to be discarded.
  const ours = isConversationId(id) ? stillWritten(id) : null
  const conv: Conversation | null = ours ? { ...structuredClone(ours.shell), messages } : read(id)
  if (!conv) return
  conv.messages = messages
  conv.updatedAt = Date.now()
  // The chat moved on from a rewind (a new message, a /compact): undoing it now would
  // throw away what came after, so the backup is dropped, and its attachments with it.
  if (conv.rewindBackup && conv.rewindBackup.afterLength !== messages.length) delete conv.rewindBackup
  // Only auto-derive over the placeholder, never over a user's own title — including a
  // deliberate rename to the literal "New chat" (guard on titleCustom, as the generated-
  // title path does), so setMessages can't clobber it on the next message.
  if (!conv.titleCustom && conv.title === 'New chat') {
    const title = deriveTitle(messages)
    if (title) conv.title = title
  }
  if (meta) {
    Object.assign(conv, meta)
    dropUnknownChatSettings(conv)
  }
  write(conv)
}

/**
 * Write a rewind (see agent/rewind.ts): the new log and compaction state (null
 * clears it), the failed-turn marker cleared or restored, and the backup that undoes
 * it (null drops it). One write, so the log and its backup can't disagree. Bumps
 * `updatedAt` like any change to the log.
 */
export function writeRewind(
  id: string,
  next: {
    messages: ChatMessage[]
    compaction: ConversationCompaction | null
    lastError: ConversationError | null
    backup: RewindBackup | null
  }
): void {
  const conv = read(id)
  if (!conv) return
  const backup = next.backup ? { ...next.backup } : null
  if (conv.forkedFrom) {
    if (backup && next.messages.length < conv.forkedFrom.historyLength) {
      // A fork rewound into the history it copied: what it says next is its own, so
      // the copied part now ends where the log does (put back by an undo).
      backup.forkedHistoryLength = conv.forkedFrom.historyLength
      conv.forkedFrom = { ...conv.forkedFrom, historyLength: next.messages.length }
    } else if (!backup && conv.rewindBackup?.forkedHistoryLength !== undefined) {
      conv.forkedFrom = { ...conv.forkedFrom, historyLength: conv.rewindBackup.forkedHistoryLength }
    }
  }
  conv.messages = next.messages
  if (next.compaction) conv.compaction = next.compaction
  else delete conv.compaction
  if (next.lastError) conv.lastError = next.lastError
  else delete conv.lastError
  if (backup) conv.rewindBackup = backup
  else delete conv.rewindBackup
  conv.updatedAt = Date.now()
  write(conv)
}

/** What {@link updateConversationMeta} can change: the chat's model, title and own settings. */
export type ConversationMetaPatch = Partial<Pick<ConversationMeta, 'providerId' | 'model' | 'title'>> &
  ConversationSettingsPatch

export function updateConversationMeta(id: string, patch: ConversationMetaPatch): void {
  const conv = read(id)
  if (!conv) return
  Object.assign(conv, patch)
  dropUnknownChatSettings(conv)
  conv.updatedAt = Date.now()
  write(conv)
}

/**
 * Save a change the user made to one chat's model, reasoning effort or approval
 * policy, as they make it (not at the next send), so switching chats and back
 * keeps it. Validated here, at the store, because the patch arrives over IPC:
 * a field that isn't a known value (or a non-empty string, for the model) is
 * ignored, never stored. Like {@link organizeConversation}, it leaves `updatedAt`
 * alone so changing a dropdown doesn't reorder the sidebar.
 */
export function setConversationSettings(id: string, patch: ConversationSettingsPatch): ConversationMeta | null {
  const conv = read(id)
  if (!conv) return null
  const p: unknown = patch
  if (typeof p !== 'object' || p === null) return toMeta(conv)
  const { providerId, model, reasoningEffort, approvalPolicy } = p as Record<string, unknown>
  // Provider and model move together: a model id only means something under its provider.
  if (typeof providerId === 'string' && providerId && typeof model === 'string' && model) {
    conv.providerId = providerId
    conv.model = model
  }
  if (isReasoningEffort(reasoningEffort)) conv.reasoningEffort = reasoningEffort
  if (isApprovalPolicy(approvalPolicy)) conv.approvalPolicy = approvalPolicy
  write(conv)
  return toMeta(conv)
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
