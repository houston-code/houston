import { parseHunkHeader } from '@shared/changes'
import type { DiffLine } from '@shared/diff'
import type { DiffHunk } from '@shared/workingTree'

/**
 * Expanding the unchanged lines around a hunk in the Changes view. A hunk carries
 * only a few lines of context; to read more, the view fetches the file as it is on
 * disk now (the same read-only, workspace-confined read the Files panel preview uses)
 * and splices the lines above or below the hunk in as context.
 *
 * Context is the same on both sides of a diff, so lines taken from the new side are
 * also the old side's lines at a fixed offset. That only holds while the file still
 * says what the diff says, so every expansion first checks that the hunk's own new
 * lines are where the header puts them; a file that changed since the view loaded
 * is not expanded (a refresh brings a diff that matches it).
 */

/** How many lines one click on "show more above/below" reveals. */
export const CONTEXT_STEP = 20

/** A hunk's first and last line on each side, 1-based and inclusive (last < first when the side is empty). */
export interface HunkSpan {
  oldFirst: number
  oldCount: number
  newFirst: number
  newCount: number
  /** The text after the second `@@` (git's function-context hint), kept when the header is rebuilt. */
  suffix: string
}

export function hunkSpan(h: DiffHunk): HunkSpan | null {
  const p = parseHunkHeader(h.header)
  if (!p) return null
  const m = /^@@[^@]*@@(.*)$/.exec(h.header)
  // A side with no lines (a pure insert or delete) names the line *before* the hunk,
  // so its first line is one past that.
  return {
    oldFirst: p.oldCount === 0 ? p.oldStart + 1 : p.oldStart,
    oldCount: p.oldCount,
    newFirst: p.newCount === 0 ? p.newStart + 1 : p.newStart,
    newCount: p.newCount,
    suffix: m ? m[1] : ''
  }
}

function newLast(s: HunkSpan): number {
  return s.newFirst + s.newCount - 1
}

/**
 * Split file text into lines the way a diff does. A trailing newline ends the last
 * line rather than starting an empty one, and a CR before the newline is dropped so
 * a CRLF file compares equal to its diff. When the text was cut at a size cap its
 * last line may be partial, so it is left out.
 */
export function fileLines(text: string, truncated = false): string[] {
  const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
  if (truncated || (lines.length > 0 && lines[lines.length - 1] === '')) lines.pop()
  return lines
}

/** Whether the file on disk still holds this hunk's new lines where its header says. */
export function hunkMatches(h: DiffHunk, lines: readonly string[]): boolean {
  const s = hunkSpan(h)
  if (!s) return false
  const newSide = h.lines.filter((l) => l.type === 'ctx' || l.type === 'add')
  if (newSide.length !== s.newCount) return false
  return newSide.every((l, k) => {
    const at = lines[s.newFirst - 1 + k]
    return at !== undefined && at.replace(/\r$/, '') === l.text.replace(/\r$/, '')
  })
}

/**
 * The unchanged lines that can be revealed above hunk `i` (up to the previous hunk's
 * last line, or the top of the file) and below it (down to the next hunk, or the end
 * of the file when it is known). Computed from the headers alone, except the room
 * below the last hunk, which needs the file's length (`total`; null until fetched).
 */
export function contextRoom(
  hunks: readonly DiffHunk[],
  i: number,
  total: number | null
): { above: number; below: number | null } {
  const s = hunkSpan(hunks[i])
  if (!s) return { above: 0, below: 0 }
  const prev = i > 0 ? hunkSpan(hunks[i - 1]) : null
  const next = i + 1 < hunks.length ? hunkSpan(hunks[i + 1]) : null
  const top = i === 0 ? 1 : prev ? newLast(prev) + 1 : s.newFirst
  const above = Math.max(0, s.newFirst - top)
  let below: number | null
  if (next) below = Math.max(0, next.newFirst - 1 - newLast(s))
  else below = total === null ? null : Math.max(0, total - newLast(s))
  return { above, below }
}

function header(oldFirst: number, oldCount: number, newFirst: number, newCount: number, suffix: string): string {
  const o = oldCount === 0 ? oldFirst - 1 : oldFirst
  const n = newCount === 0 ? newFirst - 1 : newFirst
  return `@@ -${o},${oldCount} +${n},${newCount} @@${suffix}`
}

/**
 * The hunk with `above` lines of the file prepended and `below` appended as context,
 * clamped to the room there is. Returns the hunk unchanged when nothing is asked for,
 * and null when the file no longer matches it (see {@link hunkMatches}).
 */
export function expandHunk(
  hunks: readonly DiffHunk[],
  i: number,
  lines: readonly string[] | null,
  above: number,
  below: number
): DiffHunk | null {
  const h = hunks[i]
  if (above <= 0 && below <= 0) return h
  if (!lines || !hunkMatches(h, lines)) return null
  const s = hunkSpan(h)
  if (!s) return null
  const room = contextRoom(hunks, i, lines.length)
  const up = Math.min(Math.max(0, above), room.above)
  const down = Math.min(Math.max(0, below), room.below ?? 0)
  const pre: DiffLine[] = lines.slice(s.newFirst - 1 - up, s.newFirst - 1).map((text) => ({ type: 'ctx', text }))
  const end = newLast(s)
  const post: DiffLine[] = lines.slice(end, end + down).map((text) => ({ type: 'ctx', text }))
  return {
    header: header(s.oldFirst - up, s.oldCount + up + down, s.newFirst - up, s.newCount + up + down, s.suffix),
    lines: [...pre, ...h.lines, ...post]
  }
}
