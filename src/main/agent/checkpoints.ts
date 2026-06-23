import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { resolveInRoots } from './tools'

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
  workspace: string
  files: Map<string, FileSnapshot>
}

/** Don't snapshot files larger than this (a revert of a huge file isn't worth the memory). */
const MAX_SNAPSHOT_BYTES = 5_000_000
/** Retain at most this many turns' checkpoints; the oldest are evicted first. */
const MAX_CHECKPOINTS = 50

const checkpoints = new Map<string, Checkpoint>()

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

/**
 * Record a file's current content before the turn modifies it. No-op if already
 * recorded for this run, if the path escapes the allowed roots, or if too large.
 */
export async function recordOriginal(runId: string, roots: string[], relPath: string): Promise<void> {
  const abs = resolveOrNull(roots, relPath)
  if (!abs) return

  let cp = checkpoints.get(runId)
  if (!cp) {
    // Bound memory: evict the oldest checkpoint(s) before adding a new turn's.
    while (checkpoints.size >= MAX_CHECKPOINTS) {
      const oldest = checkpoints.keys().next().value
      if (oldest === undefined) break
      checkpoints.delete(oldest)
    }
    cp = { workspace: roots[0], files: new Map() }
    checkpoints.set(runId, cp)
  }
  if (cp.files.has(abs)) return

  const { content, capped } = await readCapped(abs)
  if (capped) return // too big to snapshot — leave this file out of the checkpoint
  cp.files.set(abs, { before: content, after: null, afterCaptured: false })
}

/**
 * Record a file's content after a successful write, so the change can be redone.
 * No-op if the file wasn't snapshotted before the write (escaped / oversized).
 */
export async function recordResult(runId: string, roots: string[], relPath: string): Promise<void> {
  const abs = resolveOrNull(roots, relPath)
  if (!abs) return
  const snap = checkpoints.get(runId)?.files.get(abs)
  if (!snap) return

  const { content, capped } = await readCapped(abs)
  // A null read means the file is oversized, missing, or unreadable. Either way we
  // can't safely store the post-turn content, so redo skips this file rather than
  // recording a phantom `null` that `applyState` would execute as a delete.
  if (capped || content === null) {
    snap.afterCaptured = false
    return
  }
  snap.after = content
  snap.afterCaptured = true
}

/** Number of files snapshotted for a run (0 if none / unknown). */
export function checkpointFileCount(runId: string): number {
  return checkpoints.get(runId)?.files.size ?? 0
}

/**
 * Restore every file in a run's checkpoint to its pre-turn state. Returns the
 * number of files restored. The checkpoint is kept so the change can be redone.
 */
export async function restoreCheckpoint(runId: string): Promise<number> {
  const cp = checkpoints.get(runId)
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
  return restored
}

/**
 * Re-apply every file change in a run's checkpoint (after a revert). Returns the
 * number of files re-applied; files whose post-turn content couldn't be captured
 * are left untouched.
 */
export async function reapplyCheckpoint(runId: string): Promise<number> {
  const cp = checkpoints.get(runId)
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
  return reapplied
}

/** Drop all checkpoints (e.g. on app shutdown). */
export function clearCheckpoints(): void {
  checkpoints.clear()
}
