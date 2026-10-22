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
  /** The OS whose file-error codes to expect (default: this one). */
  platform?: NodeJS.Platform
}

type Settings = Required<FileLockOptions>

const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms))

const code = (err: unknown): string | undefined => (err as NodeJS.ErrnoException | undefined)?.code

/**
 * Windows won't create or delete a file that is mid-delete (unlinked while some
 * handle on it is still open, such as another waiter's stat or read of the lock) or
 * held open by another program (an antivirus scan, the search indexer). It reports
 * that as EPERM, EACCES or EBUSY rather than EEXIST or ENOENT. Those states clear on
 * their own, so they are waited out like a busy lock. Elsewhere the same codes are
 * real permission errors.
 */
function isWindowsBusy(err: unknown, platform: NodeJS.Platform): boolean {
  const c = code(err)
  return platform === 'win32' && (c === 'EPERM' || c === 'EACCES' || c === 'EBUSY')
}

/**
 * Run a cleanup step that removes a lock or guard file, retrying it for up to
 * `timeoutMs` while Windows reports the file busy. A cleanup that gives up strands
 * the file, and every waiter then times out until it goes stale, so a brief busy
 * spell is worth waiting out. Any other failure means the file is gone already or is
 * no longer ours, and is ignored.
 */
async function cleanUp(step: () => Promise<unknown>, s: Settings): Promise<void> {
  const deadline = Date.now() + s.timeoutMs
  for (;;) {
    try {
      await step()
      return
    } catch (err) {
      if (!isWindowsBusy(err, s.platform) || Date.now() >= deadline) return
    }
    await sleep(s.retryMs)
  }
}

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
async function takeOverStale(lock: string, staleContent: string, s: Settings): Promise<void> {
  const guard = `${lock}.takeover`
  try {
    await fs.writeFile(guard, '', { flag: 'wx' })
  } catch (err) {
    if (code(err) !== 'EEXIST') return
    try {
      if (Date.now() - (await fs.stat(guard)).mtimeMs > s.staleMs) await fs.unlink(guard)
    } catch {
      /* gone already */
    }
    return // another waiter is taking over; retry the lock
  }
  try {
    const [st, content] = await Promise.all([fs.stat(lock), fs.readFile(lock, 'utf8')])
    if (content === staleContent && Date.now() - st.mtimeMs > s.staleMs) await fs.unlink(lock)
  } catch {
    /* released or taken over already */
  } finally {
    await cleanUp(() => fs.unlink(guard), s)
  }
}

/** Run `fn` while holding `<target>.lock`; the lock is released even if `fn` throws. */
export async function withFileLock<T>(
  target: string,
  fn: () => T | Promise<T>,
  opts: FileLockOptions = {}
): Promise<T> {
  const { timeoutMs = 5000, staleMs = 30_000, retryMs = 25, platform = process.platform } = opts
  const s: Settings = { timeoutMs, staleMs, retryMs, platform }
  const lock = `${target}.lock`
  const token = randomUUID()
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let busy: unknown
    try {
      await fs.writeFile(lock, token, { flag: 'wx' })
      break
    } catch (err) {
      if (code(err) !== 'EEXIST' && !isWindowsBusy(err, platform)) throw err
      busy = err
    }
    // A lock Windows refused to create is mid-delete or held open: nothing to inspect.
    if (code(busy) === 'EEXIST') {
      try {
        const [st, content] = await Promise.all([fs.stat(lock), fs.readFile(lock, 'utf8')])
        if (Date.now() - st.mtimeMs > staleMs) {
          await takeOverStale(lock, content, s) // abandoned by a process that died mid-save
          continue
        }
      } catch (err) {
        // Released between our attempt and the check: try again now. Anything else
        // (a lock we can't read yet) waits like a busy one rather than spinning.
        if (code(err) === 'ENOENT') continue
      }
    }
    if (Date.now() >= deadline) {
      if (code(busy) !== 'EEXIST') throw busy // Windows still refuses the create: say why
      throw new Error(`${target} is being saved by another Houston window. Try again.`)
    }
    await sleep(retryMs)
  }
  try {
    return await fn()
  } finally {
    // Remove only our own lock: if ours was judged stale and taken over, the file
    // now belongs to someone else.
    await cleanUp(async () => {
      if ((await fs.readFile(lock, 'utf8')) === token) await fs.unlink(lock)
    }, s)
  }
}
