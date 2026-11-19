import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'

/** Files larger than this aren't hashed: a revert there goes unnoticed, which is harmless. */
const MAX_HASHED_BYTES = 4 * 1024 * 1024

/**
 * Remembers every version a file has had during one run (its content before and after
 * each write), so a write that puts a file back to a version it already had is seen
 * as a revert. The stall detector treats repeated reverts as edits going back and
 * forth, and the step budget doesn't count a revert as progress.
 *
 * Two writes are not reverts: one that leaves the file as it was (a no-op), and one
 * that returns it to the version the run found it in. Removing a temporary debug
 * print is finishing a change, not undoing one; counting it made two add-and-remove
 * cycles read as edits going back and forth. A return to a version the run itself
 * wrote and then moved past is what a loop looks like, and it still counts.
 *
 * Keyed by absolute path. Reads are best-effort: an unreadable, missing, or oversized
 * file is simply not tracked.
 */
export class RevertTracker {
  private readonly versions = new Map<string, Set<string>>()
  /** Each file's content when the run first wrote it (absent for a file it created). */
  private readonly original = new Map<string, string>()
  /** Each file's content just before the write in flight. */
  private readonly pending = new Map<string, string>()

  /** Record a file's content as it stands before a write. A missing file records nothing. */
  async before(absPath: string): Promise<void> {
    const hash = await contentHash(absPath)
    if (hash === null) {
      this.pending.delete(absPath)
      return
    }
    if (!this.versions.has(absPath)) this.original.set(absPath, hash)
    this.pending.set(absPath, hash)
    this.known(absPath).add(hash)
  }

  /**
   * Record a file's content after a write, and say whether that content is one the
   * file already had this run (before or after an earlier write), other than the
   * content it had just before this write or when the run first touched it.
   */
  async after(absPath: string): Promise<boolean> {
    const prior = this.pending.get(absPath)
    this.pending.delete(absPath)
    const hash = await contentHash(absPath)
    if (hash === null) return false
    const seen = this.known(absPath)
    const reverted = seen.has(hash) && hash !== prior && hash !== this.original.get(absPath)
    seen.add(hash)
    return reverted
  }

  private known(absPath: string): Set<string> {
    let set = this.versions.get(absPath)
    if (!set) {
      set = new Set()
      this.versions.set(absPath, set)
    }
    return set
  }
}

async function contentHash(absPath: string): Promise<string | null> {
  try {
    const info = await stat(absPath)
    if (!info.isFile() || info.size > MAX_HASHED_BYTES) return null
    return createHash('sha256').update(await readFile(absPath)).digest('hex')
  } catch {
    return null
  }
}
