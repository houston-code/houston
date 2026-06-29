import { statSync, openSync, readSync, closeSync } from 'node:fs'
import { basename } from 'node:path'
import { looksBinary, MAX_FILE_TEXT_BYTES, type PickedFile } from '@shared/composerContext'

/**
 * Read a user-picked file for the composer's "Attach files" action. Only the
 * first {@link MAX_FILE_TEXT_BYTES} are read (so a huge file can't be slurped
 * whole), binary files are detected and their contents omitted, and any read
 * error degrades to `content: null` rather than throwing — the path is the user's
 * own choice (a native-dialog gesture), so there's no traversal concern.
 */
export function readPickedFile(path: string): PickedFile {
  const name = basename(path)
  try {
    const size = statSync(path).size
    const len = Math.min(size, MAX_FILE_TEXT_BYTES)
    const buf = Buffer.alloc(len)
    if (len > 0) {
      const fd = openSync(path, 'r')
      try {
        readSync(fd, buf, 0, len, 0)
      } finally {
        closeSync(fd)
      }
    }
    if (looksBinary(buf)) return { path, name, bytes: size, content: null, truncated: false, binary: true }
    return {
      path,
      name,
      bytes: size,
      content: buf.toString('utf8'),
      truncated: size > MAX_FILE_TEXT_BYTES,
      binary: false
    }
  } catch {
    return { path, name, bytes: 0, content: null, truncated: false, binary: false }
  }
}
