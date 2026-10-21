import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

/**
 * A small cross-process lock for read-modify-write edits to one file.
 *
 * The rules files are edited by more than one process: the desktop app and the
 * terminal app share them, and each `#` note is a read, an append, and an atomic
 * rename. Two saves at the same moment both read the old text and the second rename
 * wins, silently dropping the first note. Holding `<file>.lock` (created with
 * O_EXCL, so only one process can) across the read and the write serializes them.
 *
 * Synchronous on purpose: the edits it guards are synchronous, and a sync lock can
 * wrap them without turning every caller async. Waiting uses Atomics.wait, so it
 * sleeps rather than spins. A lock older than `staleMs` is from a process that died
 * mid-save and is taken over; a lock that stays busy past `timeoutMs` throws, and
 * the caller reports it instead of writing.
 */

export interface FileLockOptions {
  /** Give up after this long (default 5 s). */
  timeoutMs?: number
  /** Treat a lock older than this as abandoned (default 30 s). */
  staleMs?: number
  /** Pause between attempts (default 25 ms). */
  retryMs?: number
}

const sleeper = new Int32Array(new SharedArrayBuffer(4))
function sleepSync(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms)
}

/** Run `fn` while holding `<target>.lock`; the lock is released even if `fn` throws. */
export function withFileLockSync<T>(target: string, fn: () => T, opts: FileLockOptions = {}): T {
  const { timeoutMs = 5000, staleMs = 30_000, retryMs = 25 } = opts
  const lock = `${target}.lock`
  const token = randomUUID()
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const fd = openSync(lock, 'wx')
      try {
        writeSync(fd, token)
      } finally {
        closeSync(fd)
      }
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    try {
      if (Date.now() - statSync(lock).mtimeMs > staleMs) {
        unlinkSync(lock) // abandoned by a process that died mid-save
        continue
      }
    } catch {
      continue // released between our attempt and the stat: try again now
    }
    if (Date.now() >= deadline) {
      throw new Error(`${target} is being saved by another Houston window. Try again.`)
    }
    sleepSync(retryMs)
  }
  try {
    return fn()
  } finally {
    // Remove only our own lock: if ours was judged stale and taken over, the file
    // now belongs to someone else.
    try {
      if (readFileSync(lock, 'utf8') === token) unlinkSync(lock)
    } catch {
      /* already gone */
    }
  }
}
