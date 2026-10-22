import { promises as fs } from 'node:fs'
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
 * Waiting is asynchronous: in the desktop app this runs on the main process, and a
 * blocking wait would freeze every window for as long as the lock is busy. A lock
 * older than `staleMs` is from a process that died mid-save and is taken over (see
 * {@link takeOverStale}); one that stays busy past `timeoutMs` throws, and the
 * caller reports it instead of writing.
 */

export interface FileLockOptions {
  /** Give up after this long (default 5 s). */
  timeoutMs?: number
  /** Treat a lock older than this as abandoned (default 30 s). */
  staleMs?: number
  /** Pause between attempts (default 25 ms). */
  retryMs?: number
}

const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms))

/**
 * Remove an abandoned lock without ever removing a live one. Deleting by name is
 * racy: two waiters can both judge the same lock stale, the first replaces it with
 * its own, and the second then deletes that fresh lock. So takeovers serialize on a
 * second guard file, and the one holding it re-checks, right before deleting, that
 * the lock is still the same abandoned one. While an abandoned lock exists nobody
 * can create a new one, and only a guard holder removes it, so the check can't go
 * stale before the delete. A guard left by a process that died is cleared after
 * `staleMs`, like the lock itself.
 */
async function takeOverStale(lock: string, staleContent: string, staleMs: number): Promise<void> {
  const guard = `${lock}.takeover`
  try {
    await fs.writeFile(guard, '', { flag: 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return
    try {
      if (Date.now() - (await fs.stat(guard)).mtimeMs > staleMs) await fs.unlink(guard)
    } catch {
      /* gone already */
    }
    return // another waiter is taking over; retry the lock
  }
  try {
    const [st, content] = await Promise.all([fs.stat(lock), fs.readFile(lock, 'utf8')])
    if (content === staleContent && Date.now() - st.mtimeMs > staleMs) await fs.unlink(lock)
  } catch {
    /* released or taken over already */
  } finally {
    await fs.unlink(guard).catch(() => undefined)
  }
}

/** Run `fn` while holding `<target>.lock`; the lock is released even if `fn` throws. */
export async function withFileLock<T>(
  target: string,
  fn: () => T | Promise<T>,
  opts: FileLockOptions = {}
): Promise<T> {
  const { timeoutMs = 5000, staleMs = 30_000, retryMs = 25 } = opts
  const lock = `${target}.lock`
  const token = randomUUID()
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      await fs.writeFile(lock, token, { flag: 'wx' })
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    try {
      const [st, content] = await Promise.all([fs.stat(lock), fs.readFile(lock, 'utf8')])
      if (Date.now() - st.mtimeMs > staleMs) {
        await takeOverStale(lock, content, staleMs) // abandoned by a process that died mid-save
        continue
      }
    } catch {
      continue // released between our attempt and the check: try again now
    }
    if (Date.now() >= deadline) {
      throw new Error(`${target} is being saved by another Houston window. Try again.`)
    }
    await sleep(retryMs)
  }
  try {
    return await fn()
  } finally {
    // Remove only our own lock: if ours was judged stale and taken over, the file
    // now belongs to someone else.
    try {
      if ((await fs.readFile(lock, 'utf8')) === token) await fs.unlink(lock)
    } catch {
      /* already gone */
    }
  }
}
