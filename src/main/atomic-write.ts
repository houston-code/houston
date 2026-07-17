import { writeFileSync, renameSync, unlinkSync, promises as fsp } from 'node:fs'

/**
 * Atomic file writes: write a temp file, then rename it over the target. The rename
 * is atomic on POSIX and NTFS, so a concurrent reader never sees a half-written file.
 *
 * The temp name is UNIQUE per write — `<path>.<pid>.<counter>.tmp` — not the fixed
 * `<path>.tmp` several call sites used before. Houston can run as more than one
 * process against the same userData (a second window, a headless run alongside the
 * app), and two of them writing the same file (settings.json, a conversation, the
 * secrets store) would otherwise share one temp: their bytes interleave in it, and
 * one's rename can move the file mid-write for the other, landing a corrupt result.
 * A per-writer temp removes that: each writes its own, and whichever renames last
 * lands a COMPLETE file. This prevents *corruption*, not lost updates — a stale
 * writer clobbering a newer one is a separate problem that needs locking.
 *
 * A single module-level counter is shared by the sync and async variants, so even a
 * sync and an async write racing on the same path get distinct temps. On any failure
 * the temp is cleaned up rather than left behind.
 */

let seq = 0

function tempName(path: string): string {
  return `${path}.${process.pid}.${seq++}.tmp`
}

/** Synchronous atomic write. `mode` (e.g. 0o600) is applied to the temp before rename. */
export function writeFileAtomicSync(path: string, data: string, mode?: number): void {
  const tmp = tempName(path)
  try {
    writeFileSync(tmp, data, mode === undefined ? { encoding: 'utf8' } : { encoding: 'utf8', mode })
    renameSync(tmp, path)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      // Nothing to clean up (the write itself never created it).
    }
    throw err
  }
}

/** Asynchronous atomic write. `mode` (e.g. 0o600) is applied to the temp before rename. */
export async function writeFileAtomic(path: string, data: string, mode?: number): Promise<void> {
  const tmp = tempName(path)
  try {
    await fsp.writeFile(tmp, data, mode === undefined ? { encoding: 'utf8' } : { encoding: 'utf8', mode })
    await fsp.rename(tmp, path)
  } catch (err) {
    try {
      await fsp.unlink(tmp)
    } catch {
      // Nothing to clean up.
    }
    throw err
  }
}
