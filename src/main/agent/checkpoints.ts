import { promises as fs } from 'node:fs'
import { resolveInWorkspace } from './tools'

/**
 * Lightweight file checkpoints, so a turn's file changes can be undone.
 *
 * Before the agent writes or edits a file, we snapshot that file's prior content
 * (once per path per run). "Reverting" a run writes those snapshots back —
 * restoring edited files and deleting files the turn created. Snapshots live in
 * memory for the session; they're keyed by runId (one checkpoint per turn).
 */

interface FileSnapshot {
  /** Whether the file existed before the turn touched it. */
  existed: boolean
  content: string
}

interface Checkpoint {
  workspace: string
  files: Map<string, FileSnapshot>
}

/** Don't snapshot files larger than this (a revert of a huge file isn't worth the memory). */
const MAX_SNAPSHOT_BYTES = 5_000_000

const checkpoints = new Map<string, Checkpoint>()

/**
 * Record a file's current content before the turn modifies it. No-op if already
 * recorded for this run, if the path escapes the workspace, or if it's too large.
 */
export async function recordOriginal(runId: string, workspace: string, relPath: string): Promise<void> {
  let abs: string
  try {
    abs = resolveInWorkspace(workspace, relPath)
  } catch {
    return // path escapes the workspace — the write itself will be rejected
  }

  let cp = checkpoints.get(runId)
  if (!cp) {
    cp = { workspace, files: new Map() }
    checkpoints.set(runId, cp)
  }
  if (cp.files.has(abs)) return

  try {
    const content = await fs.readFile(abs, 'utf8')
    if (Buffer.byteLength(content) > MAX_SNAPSHOT_BYTES) return // too big to snapshot
    cp.files.set(abs, { existed: true, content })
  } catch {
    // Didn't exist (or unreadable): reverting means deleting whatever the turn created.
    cp.files.set(abs, { existed: false, content: '' })
  }
}

/** Number of files snapshotted for a run (0 if none / unknown). */
export function checkpointFileCount(runId: string): number {
  return checkpoints.get(runId)?.files.size ?? 0
}

/**
 * Restore every file in a run's checkpoint to its pre-turn state. Returns the
 * number of files restored. The checkpoint is consumed (cleared) on success.
 */
export async function restoreCheckpoint(runId: string): Promise<number> {
  const cp = checkpoints.get(runId)
  if (!cp) return 0
  let restored = 0
  for (const [abs, snap] of cp.files) {
    try {
      if (snap.existed) {
        await fs.writeFile(abs, snap.content, 'utf8')
      } else {
        await fs.rm(abs, { force: true })
      }
      restored++
    } catch {
      // Best effort — keep going with the rest.
    }
  }
  checkpoints.delete(runId)
  return restored
}

/** Drop all checkpoints (e.g. on app shutdown). */
export function clearCheckpoints(): void {
  checkpoints.clear()
}
