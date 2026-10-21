import { constants as fsConstants, promises as fs, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, relative } from 'node:path'
import type { ChatMessage } from '@shared/agent'
import { isRewindableTurn } from '@shared/rewind'
import { writeFileAtomic } from '../atomic-write'
import { resolveInRoots } from './tools'
import { parsePatch } from './apply-patch'
import { getUserDataDir } from '../userData'

/**
 * Lightweight file checkpoints, so a turn's file changes can be undone *and*
 * redone.
 *
 * Before the agent writes or edits a file we snapshot its prior content (once per
 * path per run); after a successful write we snapshot the new content too.
 * "Reverting" a run restores the prior content (deleting files the turn created);
 * "re-applying" restores the post-turn content. Snapshots live in memory for the
 * session, keyed by runId (one checkpoint per turn) and bounded to the most recent
 * MAX_CHECKPOINTS so a long session can't grow without limit.
 *
 * Checkpoints are ALSO persisted to disk (userData/checkpoints), best-effort, so
 * the revert/redo affordance survives an app restart and non-GUI hosts (TUI,
 * headless) can rewind too. Each run's checkpoint is one JSON file named by its
 * runId. `index.json` keeps, per conversation, the ordered chain of its runs, each
 * tied to the user message that started it (see {@link ChainEntry}), which is what
 * lets a rewind put back every turn from an earlier message on; it also still maps
 * each conversation to its latest run, the shape older builds read. Memory remains
 * the in-session source of truth — disk is written through on every mutation and
 * read only on a miss (e.g. after a restart). A host with no user-data directory
 * wired (unit tests, embedders) silently keeps the in-memory behavior.
 */

interface FileSnapshot {
  /** Content before the turn touched it; `null` if it didn't exist. */
  before: string | null
  /** `before` is base64 of the file's bytes, not its text (see {@link readCapped}). */
  beforeBinary?: boolean
  /** Content after the turn's writes; `null` if it ended up absent. Valid only when `afterCaptured`. */
  after: string | null
  /** `after` is base64 of the file's bytes, not its text. */
  afterBinary?: boolean
  /** Whether the post-turn content was captured, so redo skips files it can't restore. */
  afterCaptured: boolean
}

interface Checkpoint {
  /** The allowed roots at record time, kept so persisted paths can be re-validated on load. */
  roots: string[]
  files: Map<string, FileSnapshot>
  /**
   * Whether this turn's changes are currently reverted (so a re-opened conversation
   * shows "redo" rather than "revert"). Tracked here, not just in the renderer,
   * so {@link getConversationCheckpoint} can restore the right state on re-adopt.
   */
  reverted: boolean
}

/** On-disk shape of one run's checkpoint (userData/checkpoints/<runId>.json). */
interface PersistedCheckpoint {
  version: number
  runId: string
  roots: string[]
  reverted: boolean
  files: {
    path: string
    before: string | null
    after: string | null
    afterCaptured: boolean
    /** Set when the content is base64 bytes rather than text (schema version 2 on). */
    beforeEncoding?: 'base64'
    afterEncoding?: 'base64'
  }[]
}

/** Don't snapshot files larger than this (a revert of a huge file isn't worth the memory). */
const MAX_SNAPSHOT_BYTES = 5_000_000
/** Keep at most this many turns' checkpoints in memory; the oldest are evicted first. */
const MAX_CHECKPOINTS = 50
/**
 * Keep at most this many run files on disk, across all conversations; the oldest
 * are pruned first. Larger than the memory cap because a rewind reaches back several
 * turns, and disk is only read on a miss.
 */
const MAX_DISK_CHECKPOINTS = 200
/** Runs remembered per conversation chain; the oldest drop off first. */
const MAX_CHAIN_ENTRIES = 100
/** Conversations whose chains index.json keeps; the least recently run drop off. */
const MAX_CHAIN_CONVERSATIONS = 500
/** Version stamped on index.json. 3 added `chains`; older builds read only `conversations`. */
const INDEX_SCHEMA_VERSION = 3
/**
 * Bump when {@link PersistedCheckpoint} changes shape. Version 2 added the base64
 * encodings for binary snapshots; it is written so an older build, which would restore
 * the base64 text as the file's content, ignores the file instead.
 */
const CHECKPOINT_SCHEMA_VERSION = 2
/** Versions this build can load: 1 differs from 2 only in never holding binary content. */
const READABLE_SCHEMA_VERSIONS = new Set([1, 2])

/**
 * Run ids safe to use as a checkpoint filename. Every client mints runIds with
 * randomUUID(), so anything else came from an untrusted IPC caller — checked
 * BEFORE a runId becomes a filename, closing the `../`-laden-id traversal path.
 * Deliberately a bit wider than UUIDs (word chars + dashes) so injected test ids
 * still persist; no dots or separators, so no traversal and no `.json` collisions.
 */
const RUN_ID_RE = /^[\w-]{1,64}$/

const checkpoints = new Map<string, Checkpoint>()

/**
 * The most recent run on each conversation, so the revert/redo affordance can be
 * restored when the conversation is re-opened (the renderer's checkpoint state is
 * otherwise rebuilt only from live events, which a transcript rebuild discards).
 * Only the latest turn is ever revertable — a new run replaces the entry — which
 * mirrors the renderer clearing the checkpoint when the next turn starts. Mirrored
 * to disk (index.json) so it also survives a restart.
 */
const lastRunByConversation = new Map<string, string>()

/**
 * One run in a conversation's chain, oldest first. `turn` ties it to the user
 * message that started it, so rewinding to that message knows which runs to undo.
 */
export interface ChainEntry {
  runId: string
  /**
   * Index in the conversation's log of the user message that started the run, or -1
   * when it didn't start from one. Absent only on an entry migrated from the old
   * latest-run-only index, whose message is inferred (see {@link resolveChainTurns}).
   */
  turn?: number
  /** {@link turnFingerprint} of that message, so a rewritten log can't misattribute the run. */
  fp?: string
  /** The run changed files (a checkpoint exists or existed), so a missing one means pruned. */
  files?: boolean
  /** The run's turn was cut from the chat by a rewind; its files can still be put back. */
  detached?: boolean
  /** When the run started (ms), to bound the index by recency. */
  at: number
}

/** Per-conversation run chains, hydrated from index.json on first use. */
const chains = new Map<string, ChainEntry[]>()
/** Which conversation each chained run belongs to, so recording can flag `files`. */
const runConversation = new Map<string, string>()

/** A short digest of a user message's text, to check a chain entry still points at it. */
export function turnFingerprint(m: ChatMessage): string {
  return createHash('sha256').update(m.content).digest('hex').slice(0, 16)
}

function isChainEntry(v: unknown): v is ChainEntry {
  if (!v || typeof v !== 'object') return false
  const e = v as Record<string, unknown>
  return (
    typeof e.runId === 'string' &&
    RUN_ID_RE.test(e.runId) &&
    (e.turn === undefined || (Number.isInteger(e.turn) && (e.turn as number) >= -1)) &&
    (e.fp === undefined || typeof e.fp === 'string') &&
    typeof e.at === 'number'
  )
}

/** The persisted index, read synchronously (it is small) and validated. Never throws. */
function readIndexSync(dir: string): {
  conversations: Record<string, string>
  chains: Record<string, ChainEntry[]>
} {
  try {
    return parseIndex(JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')))
  } catch {
    return { conversations: {}, chains: {} }
  }
}

function parseIndex(parsed: unknown): {
  conversations: Record<string, string>
  chains: Record<string, ChainEntry[]>
} {
  const conversations: Record<string, string> = {}
  const out: Record<string, ChainEntry[]> = {}
  const o = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  const conv = o.conversations
  if (conv && typeof conv === 'object' && !Array.isArray(conv)) {
    for (const [k, v] of Object.entries(conv)) if (typeof v === 'string') conversations[k] = v
  }
  const ch = o.chains
  if (ch && typeof ch === 'object' && !Array.isArray(ch)) {
    for (const [k, v] of Object.entries(ch)) {
      if (!Array.isArray(v)) continue
      out[k] = v.filter(isChainEntry).map((e) => ({
        runId: e.runId,
        ...(e.turn !== undefined ? { turn: e.turn } : {}),
        ...(e.fp !== undefined ? { fp: e.fp } : {}),
        ...(e.files === true ? { files: true } : {}),
        ...(e.detached === true ? { detached: true } : {}),
        at: e.at
      }))
    }
  }
  return { conversations, chains: out }
}

/**
 * The chain for a conversation, hydrating it from disk the first time. Migration
 * from the latest-run-only index lives here: a conversation the old index maps to a
 * run its chain doesn't end with (no chain yet, or an older build ran since) gets
 * that run appended without a `turn`, which is then inferred from the log.
 */
function chainFor(conversationId: string): ChainEntry[] {
  let chain = chains.get(conversationId)
  if (chain) return chain
  chain = []
  const dir = checkpointsDirOrNull()
  if (dir) {
    const index = readIndexSync(dir)
    if (Object.prototype.hasOwnProperty.call(index.chains, conversationId)) {
      chain = index.chains[conversationId]
    }
    const latest = Object.prototype.hasOwnProperty.call(index.conversations, conversationId)
      ? index.conversations[conversationId]
      : undefined
    if (latest && RUN_ID_RE.test(latest) && chain.at(-1)?.runId !== latest) {
      chain = [...chain.filter((e) => e.runId !== latest), { runId: latest, at: 0 }]
    }
  }
  for (const e of chain) runConversation.set(e.runId, conversationId)
  chains.set(conversationId, chain)
  return chain
}

/**
 * Remember the run currently/most-recently executing on a conversation, appended to
 * its chain. `turn` is the user message that started it, when there is one.
 */
export function noteConversationRun(
  conversationId: string,
  runId: string,
  turn?: { index: number; fp: string }
): void {
  lastRunByConversation.set(conversationId, runId)
  const chain = chainFor(conversationId)
  const existing = chain.find((e) => e.runId === runId)
  if (existing) {
    if (turn) Object.assign(existing, { turn: turn.index, fp: turn.fp })
  } else {
    chain.push({
      runId,
      turn: turn ? turn.index : -1,
      ...(turn ? { fp: turn.fp } : {}),
      at: Date.now()
    })
    while (chain.length > MAX_CHAIN_ENTRIES) {
      const dropped = chain.shift()
      if (dropped) runConversation.delete(dropped.runId)
    }
  }
  runConversation.set(runId, conversationId)
  // Fire-and-forget: the caller (startRun) is sync, and losing an index write only
  // costs the affordance after a restart, never in-session correctness.
  void scheduleWriteIndex()
}

/**
 * Point a run's chain entry at the user message that started it. startRun calls this
 * once the log is final for the turn's start: an automated note inserted ahead of the
 * user's message, or the intake repair, can move it after {@link noteConversationRun}.
 */
export function setRunTurn(conversationId: string, runId: string, index: number, fp: string): void {
  const entry = chainFor(conversationId).find((e) => e.runId === runId)
  if (!entry || (entry.turn === index && entry.fp === fp)) return
  entry.turn = index
  entry.fp = fp
  void scheduleWriteIndex()
}

/** A copy of a conversation's chain, oldest first. */
export function conversationChain(conversationId: string): ChainEntry[] {
  return chainFor(conversationId).map((e) => ({ ...e }))
}

/**
 * Mark runs whose turns a rewind cut from the chat (or, undoing it, put back). A
 * detached run is never offered as the latest turn's revert, and is never the run a
 * rewind starts from, but an earlier rewind still includes it, so code put back to
 * before an older message is put back fully.
 */
export function setRunsDetached(conversationId: string, runIds: string[], detached: boolean): void {
  const ids = new Set(runIds)
  let changed = false
  for (const e of chainFor(conversationId)) {
    if (!ids.has(e.runId) || (e.detached === true) === detached) continue
    if (detached) e.detached = true
    else delete e.detached
    changed = true
  }
  if (changed) void scheduleWriteIndex()
}

/**
 * The message index each chain entry stands for in `messages`, or null when it can't
 * be placed: a detached run, a run with no user message, or an entry whose recorded
 * message no longer matches (the log was rewritten, e.g. by /compact). An entry
 * migrated from the old index has no recorded message; it was the latest run then,
 * so it maps to the last rewind point before the next placed entry (or the end).
 */
export function resolveChainTurns(chain: ChainEntry[], messages: ChatMessage[]): (number | null)[] {
  const out: (number | null)[] = new Array(chain.length).fill(null)
  let bound = messages.length
  for (let i = chain.length - 1; i >= 0; i--) {
    const e = chain[i]
    if (e.detached) continue
    let idx: number | null = null
    if (e.turn === undefined) {
      for (let j = bound - 1; j >= 0; j--) {
        if (isRewindableTurn(messages[j])) {
          idx = j
          break
        }
      }
    } else if (
      e.turn >= 0 &&
      e.turn < messages.length &&
      isRewindableTurn(messages[e.turn]) &&
      (e.fp === undefined || e.fp === turnFingerprint(messages[e.turn]))
    ) {
      idx = e.turn
    }
    out[i] = idx
    if (idx !== null) bound = idx
  }
  return out
}

/**
 * The runs a rewind to the message at `messageIndex` undoes: the first run placed at
 * or after that message, and every run after it in time (placed or not: a later run
 * is later whatever happened to its message). Empty when no run is placed there.
 */
export function runsFromTurn(chain: ChainEntry[], messages: ChatMessage[], messageIndex: number): ChainEntry[] {
  const placed = resolveChainTurns(chain, messages)
  const start = placed.findIndex((idx) => idx !== null && idx >= messageIndex)
  return start === -1 ? [] : chain.slice(start)
}

function resolveOrNull(roots: string[], relPath: string): string | null {
  try {
    return resolveInRoots(roots, relPath)
  } catch {
    return null // path escapes the allowed roots — the write itself will be rejected
  }
}

/**
 * Read a file for a snapshot, returning `capped: true` if it's too large to keep.
 *
 * A file whose bytes are valid UTF-8 is kept as its text. Anything else (an image, an
 * archive, text in another encoding) is kept as base64 of its bytes: decoding it as
 * UTF-8 replaces every invalid sequence, so restoring that text would write a
 * corrupted file in place of the original.
 */
async function readCapped(
  abs: string
): Promise<{ content: string | null; binary: boolean; capped: boolean }> {
  let buf: Buffer
  try {
    buf = await fs.readFile(abs)
  } catch {
    return { content: null, binary: false, capped: false } // didn't exist / unreadable
  }
  if (buf.byteLength > MAX_SNAPSHOT_BYTES) return { content: null, binary: false, capped: true }
  const text = buf.toString('utf8')
  if (Buffer.from(text, 'utf8').equals(buf)) return { content: text, binary: false, capped: false }
  return { content: buf.toString('base64'), binary: true, capped: false }
}

/**
 * Write `content` back (decoding base64 when `binary`), or delete the file when
 * `content` is null. Recreates parent dirs.
 */
async function applyState(
  abs: string,
  content: string | null,
  binary = false,
  opts: { noFollow?: boolean } = {}
): Promise<void> {
  if (content === null) {
    // rm on a symlink removes the link, never its target.
    await fs.rm(abs, { force: true })
  } else {
    await fs.mkdir(dirname(abs), { recursive: true })
    // `noFollow` (the rewind path, which refuses a symlinked file outright): a symlink
    // swapped in at the file itself between that check and this write fails the open
    // rather than redirecting the write. Not defined on Windows, where it is 0. The
    // single-turn revert keeps following a symlink inside the roots, as it always has.
    const flags =
      fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_TRUNC |
      (opts.noFollow ? (fsConstants.O_NOFOLLOW ?? 0) : 0)
    const handle = await fs.open(abs, flags, 0o666)
    try {
      await handle.writeFile(binary ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8'))
    } finally {
      await handle.close()
    }
  }
}

// ---- Disk persistence (best-effort write-through under userData/checkpoints) ----

/** The checkpoints directory, or null when no user-data dir is wired (memory-only host). */
function checkpointsDirOrNull(): string | null {
  try {
    return join(getUserDataDir(), 'checkpoints')
  } catch {
    return null
  }
}

/**
 * All disk work funnels through one serialized chain so writes never interleave,
 * and every failure is swallowed — persistence is strictly best-effort and must
 * never fail a tool call or a revert. `dirtyRuns`/`indexDirty` coalesce bursts:
 * a task queued while an identical one is still pending becomes a no-op.
 */
let flushChain: Promise<void> = Promise.resolve()
const dirtyRuns = new Set<string>()
let indexDirty = false

function queueDiskTask(task: () => Promise<void>): Promise<void> {
  const next = flushChain.then(task).catch(() => {})
  flushChain = next
  return next
}

/** Await all queued disk writes (tests, or anyone needing a durability barrier). */
export function flushCheckpoints(): Promise<void> {
  return flushChain
}

async function ensureDir(dir: string): Promise<void> {
  // 0700: snapshots hold file contents from the user's projects.
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
}

async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await writeFileAtomic(path, JSON.stringify(data), 0o600)
}

async function writeRunFile(runId: string): Promise<void> {
  const dir = checkpointsDirOrNull()
  const cp = checkpoints.get(runId)
  if (!dir || !cp) return
  await ensureDir(dir)
  const data: PersistedCheckpoint = {
    version: CHECKPOINT_SCHEMA_VERSION,
    runId,
    roots: cp.roots,
    reverted: cp.reverted,
    files: [...cp.files].map(([path, s]) => ({
      path,
      before: s.before,
      after: s.after,
      afterCaptured: s.afterCaptured,
      ...(s.beforeBinary ? { beforeEncoding: 'base64' as const } : {}),
      ...(s.afterBinary ? { afterEncoding: 'base64' as const } : {})
    }))
  }
  await writeJsonAtomic(join(dir, `${runId}.json`), data)
}

/** Queue a write of this run's checkpoint file; resolves once it (or a newer one) lands. */
function schedulePersistRun(runId: string): Promise<void> {
  if (checkpointsDirOrNull() === null || !RUN_ID_RE.test(runId)) return Promise.resolve()
  dirtyRuns.add(runId)
  return queueDiskTask(async () => {
    if (!dirtyRuns.delete(runId)) return // an earlier task already wrote the latest state
    await writeRunFile(runId)
  })
}

async function readIndexConversations(dir: string): Promise<Record<string, string>> {
  return (await readIndex(dir)).conversations
}

async function readIndex(dir: string): Promise<ReturnType<typeof parseIndex>> {
  try {
    return parseIndex(JSON.parse(await fs.readFile(join(dir, 'index.json'), 'utf8')))
  } catch {
    return { conversations: {}, chains: {} } // absent or corrupt — start fresh
  }
}

/**
 * Queue an index.json write: each conversation's latest run (the shape older builds
 * read) and its run chain.
 */
function scheduleWriteIndex(): Promise<void> {
  const dir = checkpointsDirOrNull()
  if (!dir) return Promise.resolve()
  indexDirty = true
  return queueDiskTask(async () => {
    if (!indexDirty) return
    indexDirty = false
    await ensureDir(dir)
    // Read-merge-write: another Houston process (GUI + TUI share one profile) may
    // have recorded runs for conversations this one has never seen — keep them.
    // A conversation this process has loaded is written from memory, which was
    // hydrated from disk before its first change.
    const index = await readIndex(dir)
    const conversations = index.conversations
    for (const [conv, runId] of lastRunByConversation) conversations[conv] = runId
    const merged: Record<string, ChainEntry[]> = index.chains
    for (const [conv, chain] of chains) merged[conv] = chain
    // Bound the index: keep the most recently run conversations' chains.
    const kept = Object.entries(merged)
      .filter(([, chain]) => chain.length > 0)
      .sort((a, b) => (b[1].at(-1)?.at ?? 0) - (a[1].at(-1)?.at ?? 0))
      .slice(0, MAX_CHAIN_CONVERSATIONS)
    await writeJsonAtomic(join(dir, 'index.json'), {
      version: INDEX_SCHEMA_VERSION,
      conversations,
      chains: Object.fromEntries(kept)
    })
  })
}

/** Delete the oldest run files beyond the cap, mirroring the in-memory bound. */
function schedulePrune(): Promise<void> {
  const dir = checkpointsDirOrNull()
  if (!dir) return Promise.resolve()
  return queueDiskTask(async () => {
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch {
      return
    }
    const runFiles = entries.filter((f) => f.endsWith('.json') && f !== 'index.json')
    if (runFiles.length <= MAX_DISK_CHECKPOINTS) return
    const stats: { f: string; mtime: number }[] = []
    for (const f of runFiles) {
      try {
        stats.push({ f, mtime: (await fs.stat(join(dir, f))).mtimeMs })
      } catch {
        // vanished mid-scan — nothing to prune
      }
    }
    stats.sort((a, b) => a.mtime - b.mtime)
    for (const s of stats.slice(0, Math.max(0, stats.length - MAX_DISK_CHECKPOINTS))) {
      await fs.rm(join(dir, s.f), { force: true })
    }
  })
}

/**
 * Load a persisted checkpoint into memory (no-op if already there). Every stored
 * path is re-validated through {@link resolveInRoots} against the stored roots —
 * the same containment gate used at record time — so a tampered or stale file can
 * never make a restore write outside the roots it was recorded under.
 */
async function loadRunIntoMemory(runId: string): Promise<Checkpoint | null> {
  const existing = checkpoints.get(runId)
  if (existing) return existing
  const dir = checkpointsDirOrNull()
  if (!dir || !RUN_ID_RE.test(runId)) return null
  let parsed: PersistedCheckpoint
  try {
    parsed = JSON.parse(await fs.readFile(join(dir, `${runId}.json`), 'utf8')) as PersistedCheckpoint
  } catch {
    return null // absent or corrupt — treat as no checkpoint
  }
  if (
    !READABLE_SCHEMA_VERSIONS.has(parsed?.version) ||
    !Array.isArray(parsed.roots) ||
    parsed.roots.length === 0 ||
    !parsed.roots.every((r) => typeof r === 'string' && r.length > 0) ||
    !Array.isArray(parsed.files)
  ) {
    return null
  }
  const files = new Map<string, FileSnapshot>()
  for (const entry of parsed.files) {
    if (
      !entry ||
      typeof entry.path !== 'string' ||
      (entry.before !== null && typeof entry.before !== 'string') ||
      (entry.after !== null && typeof entry.after !== 'string')
    ) {
      continue
    }
    const abs = resolveOrNull(parsed.roots, entry.path)
    if (!abs) continue
    files.set(abs, {
      before: entry.before,
      ...(entry.beforeEncoding === 'base64' ? { beforeBinary: true } : {}),
      after: entry.after,
      ...(entry.afterEncoding === 'base64' ? { afterBinary: true } : {}),
      afterCaptured: entry.afterCaptured === true
    })
  }
  const cp: Checkpoint = { roots: parsed.roots, files, reverted: parsed.reverted === true }
  evictForNewCheckpoint()
  checkpoints.set(runId, cp)
  return cp
}

/** The conversation's latest runId per the on-disk index (used after a restart). */
async function runIdFromDiskIndex(conversationId: string): Promise<string | null> {
  const dir = checkpointsDirOrNull()
  if (!dir) return null
  const conversations = await readIndexConversations(dir)
  const runId = Object.prototype.hasOwnProperty.call(conversations, conversationId)
    ? conversations[conversationId]
    : undefined
  return typeof runId === 'string' && RUN_ID_RE.test(runId) ? runId : null
}

/**
 * The conversation whose LATEST run this is, or null when the runId isn't any
 * conversation's most recent turn (unknown, or already superseded by a newer run).
 * Checks memory first, then the on-disk index (after a restart nothing is in
 * memory until a checkpoint is first fetched). The IPC layer uses this to refuse
 * restore/reapply of an arbitrary historical runId among the persisted snapshots:
 * only the latest turn — the one the UI actually offers to revert — qualifies.
 */
export async function conversationForLatestRun(runId: string): Promise<string | null> {
  for (const [conversationId, r] of lastRunByConversation) {
    if (r === runId) return latestIsDetached(conversationId, runId) ? null : conversationId
  }
  const dir = checkpointsDirOrNull()
  if (!dir || !RUN_ID_RE.test(runId)) return null
  const conversations = await readIndexConversations(dir)
  for (const [conversationId, r] of Object.entries(conversations)) {
    // Memory wins over a stale on-disk entry: if this process already knows a
    // newer run for the conversation (its index write may still be queued), the
    // queried run is superseded, not latest.
    if (r === runId && (lastRunByConversation.get(conversationId) ?? runId) === runId) {
      return latestIsDetached(conversationId, runId) ? null : conversationId
    }
  }
  return null
}

/**
 * Whether a rewind cut the latest run's turn from the chat. Its single-turn
 * revert/redo is then withdrawn: redoing it would bring back code for a turn the
 * chat no longer has.
 */
function latestIsDetached(conversationId: string, runId: string): boolean {
  return chainFor(conversationId).find((e) => e.runId === runId)?.detached === true
}

// ---- Recording ----

/** A file a write-kind tool call will touch, and whether it is expected to end up deleted. */
export interface WriteTarget {
  path: string
  deleted: boolean
}

/**
 * The file paths a write-kind tool call will touch. Single-file tools contribute
 * their `path` argument; `apply_patch` contributes every path in its envelope —
 * adds, updates, deletes, and both ends of a move (the source is expected to end
 * up deleted, like an explicit Delete File). Write-kind tools that touch no files
 * directly (e.g. `dispatch_writable_agent`) contribute nothing, as does a
 * malformed patch (its execute() will fail before writing anything).
 */
export function writeTargets(toolName: string, args: Record<string, unknown>): WriteTarget[] {
  if (toolName === 'apply_patch') {
    if (typeof args.patch !== 'string') return []
    try {
      return parsePatch(args.patch).flatMap((op): WriteTarget[] => {
        if (op.type === 'delete') return [{ path: op.path, deleted: true }]
        if (op.type === 'update' && op.moveTo && op.moveTo !== op.path) {
          return [
            { path: op.path, deleted: true },
            { path: op.moveTo, deleted: false }
          ]
        }
        return [{ path: op.path, deleted: false }]
      })
    } catch {
      return []
    }
  }
  return typeof args.path === 'string' && args.path ? [{ path: args.path, deleted: false }] : []
}

/** Bound memory: evict the oldest checkpoint(s) to admit one more. */
function evictForNewCheckpoint(): void {
  while (checkpoints.size >= MAX_CHECKPOINTS) {
    const oldest = checkpoints.keys().next().value
    if (oldest === undefined) break
    checkpoints.delete(oldest)
  }
}

/**
 * Record a file's current content before the turn modifies it. No-op if already
 * recorded for this run, if the path escapes the allowed roots, or if too large.
 */
export async function recordOriginal(runId: string, roots: string[], relPath: string): Promise<void> {
  const abs = resolveOrNull(roots, relPath)
  if (!abs) return

  // Re-hydrate from disk on an in-memory miss (as every other mutator does): if this
  // run was evicted after snapshotting earlier files, a fresh empty Map would be
  // persisted over its on-disk snapshot and a revert would silently drop those files.
  let cp = checkpoints.get(runId) ?? (await loadRunIntoMemory(runId))
  const isNewCheckpoint = !cp
  if (!cp) {
    evictForNewCheckpoint()
    cp = { roots, files: new Map(), reverted: false }
    checkpoints.set(runId, cp)
    // Flag the chain entry, so a rewind can tell "changed nothing" from "pruned".
    const conv = runConversation.get(runId)
    const entry = conv ? chains.get(conv)?.find((e) => e.runId === runId) : undefined
    if (entry && !entry.files) {
      entry.files = true
      void scheduleWriteIndex()
    }
  }
  if (cp.files.has(abs)) return

  const { content, binary, capped } = await readCapped(abs)
  if (capped) return // too big to snapshot — leave this file out of the checkpoint
  cp.files.set(abs, {
    before: content,
    ...(binary ? { beforeBinary: true } : {}),
    after: null,
    afterCaptured: false
  })
  await schedulePersistRun(runId)
  // Keep the disk bounded the same way memory is. Queued AFTER the persist so the
  // prune pass sees the new run's file and the cap holds immediately.
  if (isNewCheckpoint) void schedulePrune()
}

/**
 * Record a file's content after a successful write, so the change can be redone.
 * No-op if the file wasn't snapshotted before the write (escaped / oversized).
 * Pass `expectAbsent` when the tool deliberately removed the file (apply_patch's
 * Delete File / a move's source): its absence then IS the post-turn state, so
 * redo re-deletes it rather than skipping it.
 */
export async function recordResult(
  runId: string,
  roots: string[],
  relPath: string,
  opts?: { expectAbsent?: boolean }
): Promise<void> {
  const abs = resolveOrNull(roots, relPath)
  if (!abs) return
  const snap = checkpoints.get(runId)?.files.get(abs)
  if (!snap) return

  const { content, binary, capped } = await readCapped(abs)
  snap.afterBinary = binary
  if (capped) {
    snap.afterCaptured = false
  } else if (content === null) {
    // The file is missing or unreadable. For a deliberate delete that's the
    // expected post-turn state; otherwise we can't safely store the post-turn
    // content, so redo skips this file rather than recording a phantom `null`
    // that `applyState` would execute as a delete.
    snap.after = null
    snap.afterCaptured = opts?.expectAbsent === true
  } else {
    snap.after = content
    snap.afterCaptured = true
  }
  await schedulePersistRun(runId)
}

/** Number of files snapshotted for a run (0 if none / unknown). */
export function checkpointFileCount(runId: string): number {
  return checkpoints.get(runId)?.files.size ?? 0
}

/**
 * The revertable checkpoint for a conversation's most recent run, or null when its
 * latest turn changed no files (nothing to revert) or its snapshots are gone.
 * Falls back to the on-disk copy when memory has neither the conversation nor the
 * run (an app restart), so the renderer can restore the revert/redo affordance.
 */
export async function getConversationCheckpoint(
  conversationId: string
): Promise<{ runId: string; files: number; reverted: boolean } | null> {
  let runId = lastRunByConversation.get(conversationId)
  if (!runId) {
    const fromDisk = await runIdFromDiskIndex(conversationId)
    if (!fromDisk) return null
    runId = fromDisk
    // Cache the mapping so a later restore/reapply round-trip stays consistent.
    lastRunByConversation.set(conversationId, runId)
  }
  if (latestIsDetached(conversationId, runId)) return null
  const cp = checkpoints.get(runId) ?? (await loadRunIntoMemory(runId))
  if (!cp || cp.files.size === 0) return null
  return { runId, files: cp.files.size, reverted: cp.reverted }
}

/**
 * Restore every file in a run's checkpoint to its pre-turn state. Returns the
 * number of files restored. The checkpoint is kept so the change can be redone.
 */
export async function restoreCheckpoint(runId: string): Promise<number> {
  const cp = checkpoints.get(runId) ?? (await loadRunIntoMemory(runId))
  if (!cp) return 0
  let restored = 0
  for (const [abs, snap] of cp.files) {
    // Re-validate containment at apply time, not just at record time. A path that
    // was inside the roots when snapshotted can be moved OUT of them by a symlink
    // planted since (e.g. a sandboxed `ln -s /outside ws/sub` on a parent dir), and
    // applyState writes/removes with raw fs that would follow it. Re-run the same
    // realpath gate the write tools use and skip anything that now escapes.
    if (!resolveOrNull(cp.roots, abs)) continue
    try {
      await applyState(abs, snap.before, snap.beforeBinary)
      restored++
    } catch {
      // Best effort — keep going with the rest.
    }
  }
  cp.reverted = true
  await schedulePersistRun(runId)
  return restored
}

/**
 * Re-apply every file change in a run's checkpoint (after a revert). Returns the
 * number of files re-applied; files whose post-turn content couldn't be captured
 * are left untouched.
 */
export async function reapplyCheckpoint(runId: string): Promise<number> {
  const cp = checkpoints.get(runId) ?? (await loadRunIntoMemory(runId))
  if (!cp) return 0
  let reapplied = 0
  for (const [abs, snap] of cp.files) {
    if (!snap.afterCaptured) continue
    // Same apply-time containment re-check as restoreCheckpoint (see there): a
    // symlink planted since the snapshot must not let a redo write through it.
    if (!resolveOrNull(cp.roots, abs)) continue
    try {
      await applyState(abs, snap.after, snap.afterBinary)
      reapplied++
    } catch {
      // Best effort — keep going with the rest.
    }
  }
  cp.reverted = false
  await schedulePersistRun(runId)
  return reapplied
}

// ---- Rewind: guarded multi-turn revert and its undo ----

/** A file's content as {@link readCapped} reads it, for comparing against a snapshot. */
interface FileState {
  content: string | null
  binary: boolean
}

function sameState(cur: FileState, content: string | null, binary: boolean | undefined): boolean {
  if (cur.content === null || content === null) return cur.content === content
  return cur.content === content && cur.binary === (binary === true)
}

/** A path for the user to read: relative to the run's first root when inside it. */
function displayPath(roots: string[], abs: string): string {
  const rel = relative(roots[0] ?? '', abs)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : abs
}

/**
 * The file's current state, or null when the guard can't vouch for it: it escapes
 * the run's roots now (a symlink planted on a parent since the snapshot), its last
 * component is a symlink (the agent's write tools never leave one, so something else
 * put it there), or it's too large to compare.
 */
async function currentState(roots: string[], abs: string): Promise<FileState | null> {
  if (!resolveOrNull(roots, abs)) return null
  try {
    if ((await fs.lstat(abs)).isSymbolicLink()) return null
  } catch {
    // absent: readCapped reports it as null content
  }
  const { content, binary, capped } = await readCapped(abs)
  return capped ? null : { content, binary }
}

/** The files one run's rewind put back, so undoing the rewind re-applies exactly those. */
export interface RevertedRun {
  runId: string
  files: string[]
}

export interface GuardedRevertResult {
  /** Distinct files now at their pre-turn content (written, or already there). */
  restored: number
  /** Files left alone because they changed outside the agent (display paths). */
  conflicts: string[]
  /** Runs that changed files but whose snapshots are gone (pruned). */
  unavailable: number
  /** Per run, newest first: the files put back. */
  runs: RevertedRun[]
}

/**
 * Put back the file changes of `entries` (a chain slice, oldest first) newest run
 * first, so each file walks back through every turn that touched it.
 *
 * Guarded like the stale-write check the write tools use: a file is restored only
 * when it still holds what the agent last wrote to it (or already holds what it was
 * before). Anything else changed outside the agent since, by the user, a formatter,
 * or a shell command, and is reported as a conflict and left alone rather than
 * clobbered. Containment is re-validated against the run's roots at apply time and a
 * symlinked file is refused, as in {@link restoreCheckpoint}.
 *
 * A run already reverted (the single-turn Revert, or an earlier code rewind) is
 * skipped. With `dryRun`, nothing is written: the walk runs over an in-memory
 * overlay of the files, so the preview's counts match what the real rewind does.
 */
export async function revertRunsGuarded(
  entries: ChainEntry[],
  opts: { dryRun?: boolean } = {}
): Promise<GuardedRevertResult> {
  const overlay = new Map<string, FileState>()
  const restored = new Set<string>()
  const conflicts = new Set<string>()
  const runs: RevertedRun[] = []
  let unavailable = 0
  for (const entry of [...entries].reverse()) {
    const cp = checkpoints.get(entry.runId) ?? (await loadRunIntoMemory(entry.runId))
    if (!cp) {
      if (entry.files) unavailable++
      continue
    }
    if (cp.reverted) continue
    const files: string[] = []
    for (const [abs, snap] of cp.files) {
      const cur = overlay.get(abs) ?? (await currentState(cp.roots, abs))
      const target: FileState = { content: snap.before, binary: snap.beforeBinary === true }
      if (cur && sameState(cur, snap.before, snap.beforeBinary)) {
        files.push(abs)
        restored.add(abs)
        continue
      }
      if (!cur || !snap.afterCaptured || !sameState(cur, snap.after, snap.afterBinary)) {
        conflicts.add(displayPath(cp.roots, abs))
        continue
      }
      if (!opts.dryRun) {
        try {
          await applyState(abs, snap.before, snap.beforeBinary, { noFollow: true })
        } catch {
          conflicts.add(displayPath(cp.roots, abs))
          continue
        }
      }
      overlay.set(abs, target)
      files.push(abs)
      restored.add(abs)
    }
    runs.push({ runId: entry.runId, files })
    if (!opts.dryRun) {
      cp.reverted = true
      await schedulePersistRun(entry.runId)
    }
  }
  return { restored: restored.size, conflicts: [...conflicts], unavailable, runs }
}

/**
 * Undo a rewind's code half: re-apply what each run wrote, oldest run first, for the
 * files that rewind put back. Same guard in the other direction: a file is written
 * only while it still holds its pre-turn content.
 */
export async function reapplyRunsGuarded(
  runs: RevertedRun[]
): Promise<{ reapplied: number; conflicts: string[] }> {
  const reapplied = new Set<string>()
  const conflicts = new Set<string>()
  for (const run of [...runs].reverse()) {
    if (!RUN_ID_RE.test(run.runId)) continue
    const cp = checkpoints.get(run.runId) ?? (await loadRunIntoMemory(run.runId))
    if (!cp) continue
    for (const abs of run.files) {
      // Only paths the checkpoint itself holds (validated on load): the list comes
      // from the conversation file, so it never names a path on its own authority.
      const snap = cp.files.get(abs)
      if (!snap || !snap.afterCaptured) continue
      const cur = await currentState(cp.roots, abs)
      if (cur && sameState(cur, snap.after, snap.afterBinary)) {
        reapplied.add(abs)
        continue
      }
      if (!cur || !sameState(cur, snap.before, snap.beforeBinary)) {
        conflicts.add(displayPath(cp.roots, abs))
        continue
      }
      try {
        await applyState(abs, snap.after, snap.afterBinary, { noFollow: true })
        reapplied.add(abs)
      } catch {
        conflicts.add(displayPath(cp.roots, abs))
      }
    }
    cp.reverted = false
    await schedulePersistRun(run.runId)
  }
  return { reapplied: reapplied.size, conflicts: [...conflicts] }
}

/** Drop all in-memory checkpoints (e.g. on app shutdown). The on-disk copies remain. */
export function clearCheckpoints(): void {
  checkpoints.clear()
  lastRunByConversation.clear()
  chains.clear()
  runConversation.clear()
  dirtyRuns.clear()
  indexDirty = false
}
