/**
 * The Changes view's scopes and the pure halves of its revert actions, shared by
 * the main process (which reads and writes files) and the renderer (which shows
 * the diffs and asks for a revert).
 *
 * - `turn`: what the chat's latest turn changed, from that turn's file checkpoint
 *   (each file's content before the turn) against the file as it is now.
 * - `chat`: what every turn of the chat changed, from the earliest checkpoint of
 *   each file the chat touched against the file as it is now.
 * - `tree`: every uncommitted change in the working tree, from git.
 */

import { diffLines, type DiffLine } from './diff'
import type { DiffHunk, FileDiff } from './workingTree'

export type ChangesScope = 'turn' | 'chat' | 'tree'
export const CHANGES_SCOPES: readonly ChangesScope[] = ['turn', 'chat', 'tree']

/** A checkpoint-scoped change set (the `turn` and `chat` scopes). */
export interface ChatChanges {
  files: FileDiff[]
  added: number
  removed: number
  /** Turns that changed files whose snapshots are gone (pruned), so they are missing here. */
  unavailable: number
}

/** A revert the Changes view asks for: a whole file, or one hunk of it. */
export interface ChangeRevertRequest {
  scope: ChangesScope
  /** The working-tree root (`tree`), or the chat whose checkpoints define the change. */
  workspace: string
  conversationId?: string
  /** The file's display path as the view listed it. */
  path: string
  /**
   * {@link fileDiffSignature} of the file's diff as the view showed it. The revert is
   * refused when the file's diff has changed since, so it never discards something
   * the user did not see.
   */
  signature: string
  /** Revert only this hunk (an index into the file's hunks). */
  hunk?: number
}

export type ChangeRevertResult = { ok: true } | { ok: false; error: string }

/** Unified-diff context lines, as git uses by default. */
const CONTEXT = 3

/** `@@ -a,b +c,d @@` → its numbers (a missing count is 1, as in git). */
export function parseHunkHeader(
  header: string
): { oldStart: number; oldCount: number; newStart: number; newCount: number } | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header)
  if (!m) return null
  return {
    oldStart: Number(m[1]),
    oldCount: m[2] === undefined ? 1 : Number(m[2]),
    newStart: Number(m[3]),
    newCount: m[4] === undefined ? 1 : Number(m[4])
  }
}

/** The first old and new line numbers a hunk shows, for the diff gutter. */
export function hunkStart(h: DiffHunk): { old: number; new: number } {
  const p = parseHunkHeader(h.header)
  if (!p) return { old: 1, new: 1 }
  return { old: Math.max(p.oldStart, 1), new: Math.max(p.newStart, 1) }
}

/** Group a full-file line diff into unified hunks with `@@` headers. */
export function hunksFromLines(lines: DiffLine[], context = CONTEXT): DiffHunk[] {
  const changed = lines.map((l) => l.type === 'add' || l.type === 'del')
  const hunks: DiffHunk[] = []
  let i = 0
  // Old/new line numbers (1-based) of lines[k], tracked as we walk.
  const oldNo: number[] = []
  const newNo: number[] = []
  let o = 1
  let n = 1
  for (const l of lines) {
    oldNo.push(o)
    newNo.push(n)
    if (l.type !== 'add') o++
    if (l.type !== 'del') n++
  }
  while (i < lines.length) {
    if (!changed[i]) {
      i++
      continue
    }
    const start = Math.max(0, i - context)
    let end = i
    // Extend while another change falls within 2 * context of the last one.
    for (let k = i; k < lines.length; k++) {
      if (changed[k]) end = k
      else if (k - end > 2 * context) break
    }
    const stop = Math.min(lines.length, end + context + 1)
    const slice = lines.slice(start, stop)
    const oldCount = slice.filter((l) => l.type !== 'add').length
    const newCount = slice.filter((l) => l.type !== 'del').length
    // git's convention: a zero-length side names the line before it.
    const oldStart = oldCount === 0 ? oldNo[start] - 1 : oldNo[start]
    const newStart = newCount === 0 ? newNo[start] - 1 : newNo[start]
    hunks.push({ header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, lines: slice })
    i = stop
  }
  return hunks
}

/**
 * A file's change from its content before (null: it did not exist) to now (null: it
 * no longer exists), as the Changes view shows it.
 */
export function fileDiffFromTexts(path: string, before: string | null, after: string | null): FileDiff {
  const lines = diffLines(before ?? '', after ?? '')
  const hunks = hunksFromLines(lines)
  let added = 0
  let removed = 0
  for (const l of lines) {
    if (l.type === 'add') added++
    else if (l.type === 'del') removed++
  }
  const status = before === null ? 'added' : after === null ? 'deleted' : 'modified'
  const base: FileDiff = { path, status, hunks, added, removed, binary: false }
  if (hunks.length === 0) base.note = before === null || after === null ? 'Empty file' : 'Only line endings or nothing changed'
  return base
}

/**
 * A short fingerprint of a file's diff (status, paths, every hunk line), so a revert
 * can confirm the file still has the change the user was looking at. FNV-1a over the
 * serialized diff: a check against accidental drift, not an adversary (the renderer
 * could ask for any revert anyway).
 */
export function fileDiffSignature(f: FileDiff): string {
  const parts = [f.status, f.path, f.oldPath ?? '', f.note ?? '']
  for (const h of f.hunks) {
    parts.push(h.header)
    for (const l of h.lines) parts.push(`${l.type[0]}${l.text}`)
  }
  let hash = 0x811c9dc5
  const s = parts.join('\n')
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${s.length.toString(36)}-${hash.toString(36)}`
}

/** Whether single hunks of this file can be reverted (an edited text file). */
export function canRevertHunks(f: FileDiff): boolean {
  return !f.binary && !f.note && (f.status === 'modified' || f.status === 'renamed') && f.hunks.length > 0
}

/**
 * Undo one hunk in a file's current text: the hunk's new side (context and added
 * lines) must sit at its stated position exactly, and is replaced by its old side
 * (context and removed lines). Null when the text there no longer matches, so a
 * stale view can never rewrite lines it did not show. Context lines keep their
 * bytes; restored lines take the file's dominant line ending (a stray CRLF line in
 * an LF file does not turn the hunk into CRLF). The final newline follows the old
 * side where the hunk shows it changing, and is otherwise kept as it is.
 */
export function revertHunkText(content: string, hunk: DiffHunk): string | null {
  const head = parseHunkHeader(hunk.header)
  if (!head) return null
  const endsWithNewline = content.endsWith('\n')
  const lines = content === '' ? [] : content.split('\n')
  if (endsWithNewline) lines.pop()
  // Dominant ending: strictly more CRLF than bare-LF terminators.
  const crlfCount = content.split('\r\n').length - 1
  const terminators = endsWithNewline ? lines.length : Math.max(0, lines.length - 1)
  const eol = crlfCount > terminators - crlfCount ? '\r' : ''
  const strip = (s: string): string => (s.endsWith('\r') ? s.slice(0, -1) : s)
  const newSide = hunk.lines.filter((l) => l.type === 'ctx' || l.type === 'add')
  if (newSide.length !== head.newCount) return null
  const at = head.newCount === 0 ? head.newStart : head.newStart - 1
  // A newline added at the end of a file shows as a last, empty added line (see
  // diffLines): it is the file's final "\n", not a line of its own.
  let n = newSide.length
  const last = newSide[n - 1]
  const eofNewlineAdded =
    endsWithNewline && n > 0 && at + n === lines.length + 1 && last.type === 'add' && strip(last.text) === ''
  if (eofNewlineAdded) n--
  if (at < 0 || at + n > lines.length) return null
  for (let k = 0; k < n; k++) {
    if (strip(lines[at + k]) !== strip(newSide[k].text)) return null
  }
  // Lines outside the hunk, and its context lines, keep their bytes.
  const restored: string[] = []
  let k = 0
  for (const l of hunk.lines) {
    if (l.type === 'add') {
      k++
    } else if (l.type === 'del') {
      restored.push(strip(l.text) + eol)
    } else {
      const raw = lines[at + k]
      // The file's unterminated last line has no ending to keep, and may not stay last.
      const unterminated = !endsWithNewline && at + k === lines.length - 1
      restored.push(unterminated ? strip(raw) + eol : raw)
      k++
    }
  }
  const out = [...lines.slice(0, at), ...restored, ...lines.slice(at + n)]
  if (out.length === 0) return ''
  // The final newline: gone with the added one the hunk shows; put back when the file
  // was emptied (the diff of an emptied file cannot say, and text files end in one);
  // otherwise kept as it is.
  const finalNewline = eofNewlineAdded ? false : content === '' ? true : endsWithNewline
  // A last line with no newline after it has no line ending at all.
  if (!finalNewline) out[out.length - 1] = strip(out[out.length - 1])
  return out.join('\n') + (finalNewline ? '\n' : '')
}

/** What a revert would do, in words, for the confirmation (the Changes view and `/changes revert`). */
export function revertQuestion(file: FileDiff, scope: ChangesScope, hunk?: number): string {
  if (hunk !== undefined) return `Undo this change in ${file.path}?`
  if (scope === 'tree') {
    if (file.status === 'untracked' || file.status === 'added') return `Delete ${file.path}? It is not committed.`
    return `Discard all uncommitted changes to ${file.path}?`
  }
  if (file.status === 'added') return `Delete ${file.path}? The chat created it.`
  return `Put ${file.path} back as it was before ${scope === 'turn' ? 'this turn' : 'this chat'}?`
}
