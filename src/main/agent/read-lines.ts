import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { BINARY_SNIFF_BYTES } from './attachments'
import { displayLines, numberedLine, numberWidth } from './line-numbers'

/**
 * How `read_file` turns a text file into its numbered listing, without holding the
 * file in memory.
 *
 * The listing only ever shows up to {@link MAX_READ_CHARS} of the file, but reading
 * it used to load every byte first, decode all of it to a string, and split that into
 * lines. A model reading a few lines of a multi-hundred-megabyte log made the main
 * process hold several copies of the log at once (bytes, UTF-16 string, line array),
 * enough to stall it or run it out of memory, and anything past ~512 MB failed with a
 * string-length error. {@link streamNumberedRead} reads the file in chunks instead:
 * it keeps only the lines the listing can show, counts the rest, and hashes the bytes
 * as they pass for the stale-write tracker, so memory stays bounded however large the
 * file is. {@link numberedRead} formats a string already in memory the same way, and
 * both go through {@link formatWindow}, so the two produce identical output.
 */

/** Longest listing `read_file` returns before cutting it at a whole line. */
export const MAX_READ_CHARS = 100_000

/** The part of a file a listing is built from: a range of lines and the file's size in lines. */
interface LineWindow {
  /** Lines in the file, as {@link displayLines} counts them. */
  total: number
  /** 0-based first line of the range. */
  start: number
  /** 0-based end of the range (exclusive), clamped to `total`. */
  end: number
  /**
   * The range's lines from `start` on, as many as the listing could possibly show: it
   * may stop short of `end` once their text alone passes the budget, and a line is
   * kept only up to the budget (its real length is in `firstLength` for the first).
   */
  lines: string[]
  /** Full length of line `start`, which a cut-short first line reports. */
  firstLength: number
}

/** Render a window as `read_file` shows it. The single formatter for both read paths. */
function formatWindow(w: LineWindow, ranged: boolean): string {
  const { total, start, end } = w
  if (total === 0) return '[empty file]'
  if (start >= end) {
    return `[no lines in range: offset ${start + 1}, file has ${total} line${total === 1 ? '' : 's'}]`
  }
  const width = numberWidth(total)
  const rows: string[] = []
  let size = 0
  for (let i = 0; i < w.lines.length && start + i < end; i++) {
    const row = numberedLine(start + i + 1, width, w.lines[i])
    if (rows.length > 0 && size + 1 + row.length > MAX_READ_CHARS) break
    rows.push(row)
    size += (rows.length > 1 ? 1 : 0) + row.length
  }
  const last = start + rows.length // 1-based number of the last line shown
  let notice = ''
  if (rows[0].length > MAX_READ_CHARS) {
    // A single line longer than the whole budget (minified code, a data blob) can't
    // be shown whole; cut it rather than show nothing, and say so.
    rows[0] = rows[0].slice(0, MAX_READ_CHARS)
    notice = `\n[truncated: line ${start + 1} is ${w.firstLength} chars, cut at ${MAX_READ_CHARS}. The file has ${total} line${total === 1 ? '' : 's'}${last < total ? `; the next one is ${last + 1}` : ''}. Inspect long lines with run_shell (e.g. cut -c or fold).]`
  } else if (last < end) {
    notice = `\n[truncated at ${MAX_READ_CHARS} chars: showing lines ${start + 1}-${last} of ${total}. Continue with offset ${last + 1}.]`
  }
  const header = ranged ? `[lines ${start + 1}-${last} of ${total}]\n` : ''
  return `${header}${rows.join('\n')}${notice}`
}

/** 0-based `[start, end)` for a 1-based `offset`/`limit`, before clamping `end` to the file. */
function rangeOf(offset: number | undefined, limit: number | undefined): { start: number; end: number } {
  const start = Math.max(0, Math.floor(offset ?? 1) - 1)
  const end = limit !== undefined ? start + Math.max(0, Math.floor(limit)) : Infinity
  return { start, end }
}

/**
 * A text file as `read_file` shows it: each line prefixed with its number (see
 * line-numbers.ts), `offset`/`limit` selecting a 1-based range, and the output cut
 * at a whole line once it reaches {@link MAX_READ_CHARS}. A range carries a
 * `[lines a-b of n]` header; a cut says which line it stopped after and where to
 * pick up, so the model can page through a large file without guessing.
 */
export function numberedRead(text: string, offset?: number, limit?: number): string {
  const all = displayLines(text)
  const { start, end } = rangeOf(offset, limit)
  return formatWindow(
    {
      total: all.length,
      start,
      end: Math.min(all.length, end),
      lines: all.slice(start, Math.min(all.length, end)),
      firstLength: all[start]?.length ?? 0
    },
    offset !== undefined || limit !== undefined
  )
}

/** What {@link streamNumberedRead} found. */
export type StreamedRead =
  | { binary: false; output: string; digest: string; bytes: number }
  /** The file has a NUL byte near its start, so it isn't text; nothing was listed. */
  | { binary: true; digest: string; bytes: number }

/**
 * Read `abs` in chunks and build its `read_file` listing, holding at most about
 * {@link MAX_READ_CHARS} of it in memory. The whole file is still read once: the
 * listing names its total line count, and `digest` (SHA-256, base64, the format
 * `contentDigest` produces) covers every byte so the stale-write tracker can record it.
 */
export async function streamNumberedRead(
  abs: string,
  offset?: number,
  limit?: number
): Promise<StreamedRead> {
  const { start, end } = rangeOf(offset, limit)
  const hash = createHash('sha256')
  const decoder = new StringDecoder('utf8')
  const kept: string[] = []
  let keptChars = 0
  let collecting = true
  let lineIndex = 0
  let current = '' // the line being read, kept only while it is in range
  let currentLength = 0
  let firstLength = 0
  let bytes = 0
  let sniffed = false
  let binary = false

  const keepsCurrent = (): boolean => collecting && lineIndex >= start && lineIndex < end
  const endLine = (): void => {
    if (lineIndex === start) firstLength = currentLength
    if (keepsCurrent()) {
      kept.push(current)
      keptChars += current.length + 1
      // Formatted rows are longer than their text, so once the text alone is past the
      // budget no later line can be shown: stop keeping them (but keep counting).
      if (keptChars > MAX_READ_CHARS) collecting = false
    }
    lineIndex++
    current = ''
    currentLength = 0
  }
  const take = (text: string): void => {
    let from = 0
    for (;;) {
      const nl = text.indexOf('\n', from)
      const piece = nl === -1 ? text.slice(from) : text.slice(from, nl)
      currentLength += piece.length
      // One line can be far longer than the listing (a minified bundle): keep just
      // enough of it to fill the listing.
      if (keepsCurrent() && current.length <= MAX_READ_CHARS) {
        current += piece.slice(0, MAX_READ_CHARS + 1 - current.length)
      }
      if (nl === -1) return
      endLine()
      from = nl + 1
    }
  }

  const stream = createReadStream(abs, { highWaterMark: 64 * 1024 })
  let head = Buffer.alloc(0)
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    hash.update(chunk)
    bytes += chunk.length
    if (!sniffed) {
      // Decide text vs binary on the same leading bytes `looksBinary` checks.
      head = Buffer.concat([head, chunk])
      if (head.length < BINARY_SNIFF_BYTES) continue
      sniffed = true
      binary = head.subarray(0, BINARY_SNIFF_BYTES).includes(0)
      if (!binary) take(decoder.write(head))
      head = Buffer.alloc(0)
      continue
    }
    if (!binary) take(decoder.write(chunk))
  }
  if (!sniffed) {
    binary = head.includes(0)
    if (!binary) take(decoder.write(head))
  }
  const digest = hash.digest('base64')
  if (binary) return { binary: true, digest, bytes }
  take(decoder.end())
  // displayLines drops the empty segment after a final newline: a last line counts
  // only when it has text.
  if (currentLength > 0) endLine()
  const total = lineIndex
  return {
    binary: false,
    digest,
    bytes,
    output: formatWindow(
      { total, start, end: Math.min(total, end), lines: kept, firstLength },
      offset !== undefined || limit !== undefined
    )
  }
}
