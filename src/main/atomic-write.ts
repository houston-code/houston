import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  promises as fsp
} from 'node:fs'

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
 *
 * The temp's data is fsynced before the rename, so a power loss or OS crash leaves
 * either the old file or the complete new one, never the renamed-but-empty file a
 * journaling filesystem can otherwise surface. The directory is deliberately not
 * fsynced after the rename: losing the rename in a crash only brings back the old
 * complete file, and a second fsync would double the cost. An fsync costs a few ms,
 * so a caller on a hot synchronous path can opt out (see writeFileAtomicStampedSync).
 * On Windows the rename is retried briefly while the target is held open by another
 * process (antivirus, an indexer, another Houston), which Windows reports as EPERM /
 * EACCES / EBUSY.
 */

let seq = 0

function tempName(path: string): string {
  return `${path}.${process.pid}.${seq++}.tmp`
}

/** Pauses between Windows rename retries: a few hundred ms in all. */
const RENAME_BACKOFF_MS = [20, 40, 80, 160]

function isWindowsBusy(err: unknown): boolean {
  const c = (err as NodeJS.ErrnoException | null)?.code
  return process.platform === 'win32' && (c === 'EPERM' || c === 'EACCES' || c === 'EBUSY')
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Write `data` to a new file at `tmp` and, when `durable`, flush it to stable storage. */
function writeTempSync(tmp: string, data: string, mode: number | undefined, durable: boolean): void {
  const fd = openSync(tmp, 'w', mode ?? 0o666)
  try {
    writeFileSync(fd, data, 'utf8')
    if (durable) fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function renameRetrySync(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to)
      return
    } catch (err) {
      if (attempt >= RENAME_BACKOFF_MS.length || !isWindowsBusy(err)) throw err
      sleepSync(RENAME_BACKOFF_MS[attempt])
    }
  }
}

/**
 * Keep the bytes of a store file that could not be loaded, as
 * `<path>.corrupt-<timestamp>` (0600), before the caller falls back to defaults and its
 * next save replaces the file. A file that can't even be read (owned by root after a
 * sudo run) is moved aside instead: a rename needs no read access, and the next save
 * would replace it all the same. Returns where the bytes now are, or null when neither
 * worked. Never throws.
 */
export function preserveCorruptFile(path: string, now: Date = new Date()): string | null {
  const dest = `${path}.corrupt-${now.toISOString().replace(/[:.]/g, '-')}`
  let bytes: Buffer
  try {
    bytes = readFileSync(path)
  } catch {
    try {
      renameSync(path, dest)
      return dest
    } catch {
      return null
    }
  }
  try {
    // Created 0600 from the start (the original may hold credentials' ciphertext), and
    // never over an existing file.
    writeFileSync(dest, bytes, { mode: 0o600, flag: 'wx' })
    return dest
  } catch {
    return null
  }
}

/** Synchronous atomic write. `mode` (e.g. 0o600) is applied to the temp before rename. */
export function writeFileAtomicSync(path: string, data: string, mode?: number): void {
  const tmp = tempName(path)
  try {
    writeTempSync(tmp, data, mode, true)
    renameRetrySync(tmp, path)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      // Nothing to clean up (the write itself never created it).
    }
    throw err
  }
}

/**
 * {@link writeFileAtomicSync}, returning the identity of the file it put in place:
 * inode, mtime and size, read from the temp before the rename (a rename keeps all
 * three). A caller that caches what it wrote can later tell "still my file" from "some
 * other process has replaced it" without a window between the rename and a stat of the
 * final path, in which that other process's file could be mistaken for its own.
 *
 * `durable: false` skips the fsync, for a caller that writes many times a second on
 * the main thread and accepts that a power loss may leave the file truncated.
 */
export function writeFileAtomicStampedSync(
  path: string,
  data: string,
  mode?: number,
  { durable = true }: { durable?: boolean } = {}
): string {
  const tmp = tempName(path)
  try {
    writeTempSync(tmp, data, mode, durable)
    const st = statSync(tmp)
    renameRetrySync(tmp, path)
    return `${st.ino}:${st.mtimeMs}:${st.size}`
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
    const handle = await fsp.open(tmp, 'w', mode ?? 0o666)
    try {
      await handle.writeFile(data, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await fsp.rename(tmp, path)
        break
      } catch (err) {
        if (attempt >= RENAME_BACKOFF_MS.length || !isWindowsBusy(err)) throw err
        await new Promise((r) => setTimeout(r, RENAME_BACKOFF_MS[attempt]))
      }
    }
  } catch (err) {
    try {
      await fsp.unlink(tmp)
    } catch {
      // Nothing to clean up.
    }
    throw err
  }
}
