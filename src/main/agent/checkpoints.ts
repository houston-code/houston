import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
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
 * headless) can grow a rewind later. Each run's checkpoint is one JSON file named
 * by its runId; `index.json` maps each conversation to its latest run. Memory
 * remains the in-session source of truth — disk is written through on every
 * mutation and read only on a miss (e.g. after a restart). A host with no
 * user-data directory wired (unit tests, embedders) silently keeps the
 * in-memory behavior.
 */

interface FileSnapshot {
  /** Content before the turn touched it; `null` if it didn't exist. */
  before: string | null
  /** Content after the turn's writes; `null` if it ended up absent. Valid only when `afterCaptured`. */
  after: string | null
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
  files: { path: string; before: string | null; after: string | null; afterCaptured: boolean }[]
}

/** Don't snapshot files larger than this (a revert of a huge file isn't worth the memory). */
const MAX_SNAPSHOT_BYTES = 5_000_000
/** Retain at most this many turns' checkpoints; the oldest are evicted first. */
const MAX_CHECKPOINTS = 50
/** Bump when {@link PersistedCheckpoint} changes shape; older files are ignored. */
const CHECKPOINT_SCHEMA_VERSION = 1

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

/** Remember the run currently/most-recently executing on a conversation. */
export function noteConversationRun(conversationId: string, runId: string): void {
  lastRunByConversation.set(conversationId, runId)
  // Fire-and-forget: the caller (startRun) is sync, and losing an index write only
  // costs the affordance after a restart, never in-session correctness.
  void scheduleWriteIndex()
}

function resolveOrNull(roots: string[], relPath: string): string | null {
  try {
    return resolveInRoots(roots, relPath)
  } catch {
    return null // path escapes the allowed roots — the write itself will be rejected
  }
}

/** Read a file, returning `capped: true` if it's too large to snapshot. */
async function readCapped(abs: string): Promise<{ content: string | null; capped: boolean }> {
  try {
    const content = await fs.readFile(abs, 'utf8')
    if (Buffer.byteLength(content) > MAX_SNAPSHOT_BYTES) return { content: null, capped: true }
    return { content, capped: false }
  } catch {
    return { content: null, capped: false } // didn't exist / unreadable
  }
}

/** Write `content` back, or delete the file when `content` is null. Recreates parent dirs. */
async function applyState(abs: string, content: string | null): Promise<void> {
  if (content === null) {
    await fs.rm(abs, { force: true })
  } else {
    await fs.mkdir(dirname(abs), { recursive: true })
    await fs.writeFile(abs, content, 'utf8')
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
  const tmp = `${path}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 })
  await fs.rename(tmp, path)
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
      afterCaptured: s.afterCaptured
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
  try {
    const parsed = JSON.parse(await fs.readFile(join(dir, 'index.json'), 'utf8')) as {
      conversations?: unknown
    }
    const conv = parsed?.conversations
    if (conv && typeof conv === 'object' && !Array.isArray(conv)) {
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(conv)) if (typeof v === 'string') out[k] = v
      return out
    }
  } catch {
    // absent or corrupt — start fresh
  }
  return {}
}

/** Queue an index.json write mapping each conversation to its latest run. */
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
    const conversations = await readIndexConversations(dir)
    for (const [conv, runId] of lastRunByConversation) conversations[conv] = runId
    await writeJsonAtomic(join(dir, 'index.json'), {
      version: CHECKPOINT_SCHEMA_VERSION,
      conversations
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
    if (runFiles.length <= MAX_CHECKPOINTS) return
    const stats: { f: string; mtime: number }[] = []
    for (const f of runFiles) {
      try {
        stats.push({ f, mtime: (await fs.stat(join(dir, f))).mtimeMs })
      } catch {
        // vanished mid-scan — nothing to prune
      }
    }
    stats.sort((a, b) => a.mtime - b.mtime)
    for (const s of stats.slice(0, Math.max(0, stats.length - MAX_CHECKPOINTS))) {
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
    parsed?.version !== CHECKPOINT_SCHEMA_VERSION ||
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
      after: entry.after,
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
    if (r === runId) return conversationId
  }
  const dir = checkpointsDirOrNull()
  if (!dir || !RUN_ID_RE.test(runId)) return null
  const conversations = await readIndexConversations(dir)
  for (const [conversationId, r] of Object.entries(conversations)) {
    // Memory wins over a stale on-disk entry: if this process already knows a
    // newer run for the conversation (its index write may still be queued), the
    // queried run is superseded, not latest.
    if (r === runId && (lastRunByConversation.get(conversationId) ?? runId) === runId) {
      return conversationId
    }
  }
  return null
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

  let cp = checkpoints.get(runId)
  const isNewCheckpoint = !cp
  if (!cp) {
    evictForNewCheckpoint()
    cp = { roots, files: new Map(), reverted: false }
    checkpoints.set(runId, cp)
  }
  if (cp.files.has(abs)) return

  const { content, capped } = await readCapped(abs)
  if (capped) return // too big to snapshot — leave this file out of the checkpoint
  cp.files.set(abs, { before: content, after: null, afterCaptured: false })
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

  const { content, capped } = await readCapped(abs)
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
    try {
      await applyState(abs, snap.before)
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
    try {
      await applyState(abs, snap.after)
      reapplied++
    } catch {
      // Best effort — keep going with the rest.
    }
  }
  cp.reverted = false
  await schedulePersistRun(runId)
  return reapplied
}

/** Drop all in-memory checkpoints (e.g. on app shutdown). The on-disk copies remain. */
export function clearCheckpoints(): void {
  checkpoints.clear()
  lastRunByConversation.clear()
  dirtyRuns.clear()
  indexDirty = false
}
