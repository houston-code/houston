import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  promises as fs,
  readSync,
  statSync,
  type Stats
} from 'node:fs'

/**
 * Reading files the agent names, without hanging on ones that aren't files.
 *
 * `fs.readFile` on a FIFO blocks in open(2) until a writer shows up, which may be never;
 * on a character device such as /dev/zero it reads forever. Each such read pins one of
 * libuv's four threadpool threads, so a handful of them stall every later `fs.promises`
 * call in the process, and Stop can't cancel a blocked syscall. Every read here checks
 * the target first (following symlinks, as a read would) and refuses anything but a
 * regular file; the open itself uses O_NONBLOCK so a FIFO swapped in after the check
 * still can't block it, and the opened descriptor is checked again before a byte is read.
 *
 * Windows has no FIFOs and its devices (`NUL`, `CON`) read like files did before, so
 * there the refusal is skipped and reads behave as plain `fs` reads.
 */

/** POSIX only (undefined on Windows): open(2) returns at once on a FIFO with no writer. */
const O_NONBLOCK = fsConstants.O_NONBLOCK ?? 0

const CHECKS_TYPE = process.platform !== 'win32'

/** The error code a non-regular target is refused with. */
export const NOT_REGULAR_FILE = 'ENOTREGULAR'

function kindOf(st: Stats): string {
  if (st.isFIFO()) return 'a FIFO (named pipe)'
  if (st.isSocket()) return 'a socket'
  if (st.isCharacterDevice()) return 'a character device'
  if (st.isBlockDevice()) return 'a block device'
  return 'not a regular file'
}

function refusal(st: Stats, display: string): NodeJS.ErrnoException {
  if (st.isDirectory()) {
    const e = new Error(`EISDIR: illegal operation on a directory, read '${display}'`) as NodeJS.ErrnoException
    e.code = 'EISDIR'
    return e
  }
  const e = new Error(
    `${display} is ${kindOf(st)}, not a regular file, so it was not read (reading it could wait forever or never end).`
  ) as NodeJS.ErrnoException
  e.code = NOT_REGULAR_FILE
  return e
}

/** Whether `e` is the refusal {@link openRegularFile} throws for a FIFO, socket, or device. */
export function isNotRegularFileError(e: unknown): boolean {
  return (e as NodeJS.ErrnoException | null)?.code === NOT_REGULAR_FILE
}

/**
 * Open `abs` for reading, refusing (before opening it) anything that is not a regular
 * file once symlinks are followed. A directory is refused with EISDIR, as `fs.readFile`
 * would; a FIFO, socket, or device with {@link NOT_REGULAR_FILE}. The caller closes the
 * handle.
 */
export async function openRegularFile(abs: string, display = abs): Promise<fs.FileHandle> {
  if (!CHECKS_TYPE) return fs.open(abs, 'r')
  // Check before opening: even a non-blocking open of a FIFO would release a writer
  // that is waiting on it, which then fails once we close.
  const before = await fs.stat(abs)
  if (!before.isFile()) throw refusal(before, display)
  const fh = await fs.open(abs, fsConstants.O_RDONLY | O_NONBLOCK)
  try {
    const st = await fh.stat()
    if (!st.isFile()) throw refusal(st, display)
    return fh
  } catch (e) {
    await fh.close().catch(() => {})
    throw e
  }
}

/** `fs.readFile`, refusing a FIFO, socket, or device (see {@link openRegularFile}). */
export async function readRegularFile(abs: string, display = abs): Promise<Buffer> {
  const fh = await openRegularFile(abs, display)
  try {
    return await fh.readFile()
  } finally {
    await fh.close().catch(() => {})
  }
}

/** {@link openRegularFile}, synchronously: the open file descriptor, which the caller closes. */
export function openRegularFileSync(abs: string, display = abs): number {
  if (!CHECKS_TYPE) return openSync(abs, 'r')
  const before = statSync(abs)
  if (!before.isFile()) throw refusal(before, display)
  const fd = openSync(abs, fsConstants.O_RDONLY | O_NONBLOCK)
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) throw refusal(st, display)
    return fd
  } catch (e) {
    closeSync(fd)
    throw e
  }
}

/** What {@link readRegularFileCapped} found: the bytes, or the size when over the cap. */
export type CappedRead = { buf: Buffer } | { tooLarge: number }

/**
 * A regular file's bytes when it holds at most `maxBytes`, else its size, never reading
 * more than `maxBytes + 1` (a file that grows while it is read still stops there).
 * Refuses a FIFO, socket, or device like {@link openRegularFile}.
 */
export async function readRegularFileCapped(abs: string, maxBytes: number): Promise<CappedRead> {
  const fh = await openRegularFile(abs)
  try {
    const size = (await fh.stat()).size
    if (size > maxBytes) return { tooLarge: size }
    const buf = Buffer.allocUnsafe(maxBytes + 1)
    let got = 0
    for (;;) {
      const { bytesRead } = await fh.read(buf, got, buf.length - got, null)
      if (bytesRead === 0) break
      got += bytesRead
      if (got === buf.length) return { tooLarge: Math.max(size, got) }
    }
    return { buf: buf.subarray(0, got) }
  } finally {
    await fh.close().catch(() => {})
  }
}

/** {@link readRegularFileCapped}, synchronously. */
export function readRegularFileCappedSync(abs: string, maxBytes: number): CappedRead {
  const fd = openRegularFileSync(abs)
  try {
    const size = fstatSync(fd).size
    if (size > maxBytes) return { tooLarge: size }
    const buf = Buffer.allocUnsafe(maxBytes + 1)
    let got = 0
    for (;;) {
      const n = readSync(fd, buf, got, buf.length - got, null)
      if (n === 0) break
      got += n
      if (got === buf.length) return { tooLarge: Math.max(size, got) }
    }
    return { buf: buf.subarray(0, got) }
  } finally {
    closeSync(fd)
  }
}
