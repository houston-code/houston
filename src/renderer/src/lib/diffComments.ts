import type { ReviewComment } from '@shared/promptInvocation'
import type { FileDiff } from '@shared/workingTree'
import { hunkStart } from '@shared/changes'
import { numberDiff } from '@shared/diff'

/**
 * Line comments left in the Changes view, waiting to be sent to the agent. Kept per
 * chat (and folder) outside React, so they survive the view closing, switching scope,
 * or switching to another chat and back, until they are sent or cleared. Not saved to
 * disk: they are a draft, like an unsent message.
 */
export interface DraftComment extends ReviewComment {
  id: string
}

const drafts = new Map<string, DraftComment[]>()

export function draftKey(conversationId: string | null, workspace: string | null): string {
  return `${conversationId ?? ''}\u0000${workspace ?? ''}`
}

export function getDrafts(key: string): DraftComment[] {
  return drafts.get(key) ?? []
}

export function setDrafts(key: string, list: DraftComment[]): void {
  if (list.length === 0) drafts.delete(key)
  else drafts.set(key, list)
}

/** Where a comment sits: its file, side and line. */
export function commentPlace(c: Pick<ReviewComment, 'path' | 'side' | 'line'>): string {
  return `${c.path}\u0000${c.side}:${c.line}`
}

/** Comments in reading order: by file, then line, a removed line before the one replacing it. */
export function sortComments<T extends ReviewComment>(list: readonly T[]): T[] {
  const sideRank = (c: ReviewComment): number => (c.side === 'old' ? 0 : 1)
  return [...list].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || sideRank(a) - sideRank(b))
}

/**
 * The code each commentable line shows, by {@link commentPlace}: a removed line on its
 * old side, an added or unchanged line on its new side, for the first `cap` lines of
 * each hunk (what the diff view renders).
 */
export function shownLines(files: readonly FileDiff[], cap: number): Map<string, string> {
  const out = new Map<string, string>()
  for (const f of files) {
    if (f.note) continue
    for (const h of f.hunks) {
      const start = hunkStart(h)
      for (const l of numberDiff(h.lines).slice(0, cap)) {
        if (l.type === 'del' && l.oldNo !== undefined) out.set(commentPlace({ path: f.path, side: 'old', line: l.oldNo + start.old - 1 }), l.text)
        else if (l.type !== 'del' && l.type !== 'skip' && l.newNo !== undefined)
          out.set(commentPlace({ path: f.path, side: 'new', line: l.newNo + start.new - 1 }), l.text)
      }
    }
  }
  return out
}

/**
 * Split comments into those still on the code they were left on (shown under that
 * line) and the rest: the line moved or changed after a refresh, or is not in this
 * view at all. The rest are listed apart so nothing counted and sent is out of sight,
 * and a card never sits under code it wasn't written about.
 */
export function anchorComments<T extends ReviewComment>(
  list: readonly T[],
  lines: ReadonlyMap<string, string>
): { anchored: T[]; outdated: T[] } {
  const anchored: T[] = []
  const outdated: T[] = []
  for (const c of list) (lines.get(commentPlace(c)) === c.code ? anchored : outdated).push(c)
  return { anchored, outdated }
}

let seq = 0
export function newCommentId(): string {
  seq += 1
  return `c${Date.now().toString(36)}${seq}`
}

/** Test seam. */
export function clearAllDrafts(): void {
  drafts.clear()
}
