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
 * Keyed by absolute path. Reads are best-effort: an unreadable, missing, or oversized
 * file is simply not tracked.
 */
export class RevertTracker {
  private readonly versions = new Map<string, Set<string>>()

  /** Record a file's content as it stands before a write. A missing file records nothing. */
  async before(absPath: string): Promise<void> {
    const hash = await contentHash(absPath)
    if (hash !== null) this.known(absPath).add(hash)
  }

  /**
   * Record a file's content after a write, and say whether that content is one the
   * file already had this run (before or after an earlier write).
   */
  async after(absPath: string): Promise<boolean> {
    const hash = await contentHash(absPath)
    if (hash === null) return false
    const seen = this.known(absPath)
    const reverted = seen.has(hash)
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
