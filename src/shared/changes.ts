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
 * stale view can never rewrite lines it did not show. Keeps the file's line endings
 * (CRLF stays CRLF) and whether it ends in a newline.
 */
export function revertHunkText(content: string, hunk: DiffHunk): string | null {
  const head = parseHunkHeader(hunk.header)
  if (!head) return null
  const crlf = content.includes('\r\n')
  const endsWithNewline = content.endsWith('\n')
  const lines = content === '' ? [] : content.split('\n')
  if (endsWithNewline) lines.pop()
  const strip = (s: string): string => (s.endsWith('\r') ? s.slice(0, -1) : s)
  const newSide = hunk.lines.filter((l) => l.type === 'ctx' || l.type === 'add').map((l) => strip(l.text))
  const oldSide = hunk.lines.filter((l) => l.type === 'ctx' || l.type === 'del').map((l) => strip(l.text))
  if (newSide.length !== head.newCount) return null
  const at = head.newCount === 0 ? head.newStart : head.newStart - 1
  if (at < 0 || at + newSide.length > lines.length) return null
  for (let k = 0; k < newSide.length; k++) {
    if (strip(lines[at + k]) !== newSide[k]) return null
  }
  // Lines outside the hunk keep their bytes; restored lines take the file's ending.
  const restored = oldSide.map((t) => (crlf ? `${t}\r` : t))
  const out = [...lines.slice(0, at), ...restored, ...lines.slice(at + newSide.length)]
  if (out.length === 0) return ''
  // A last line with no newline after it has no line ending at all.
  if (!endsWithNewline) out[out.length - 1] = strip(out[out.length - 1])
  return out.join('\n') + (endsWithNewline ? '\n' : '')
}
