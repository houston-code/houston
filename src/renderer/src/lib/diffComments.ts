import type { ReviewComment } from '@shared/promptInvocation'

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

let seq = 0
export function newCommentId(): string {
  seq += 1
  return `c${Date.now().toString(36)}${seq}`
}

/** Test seam. */
export function clearAllDrafts(): void {
  drafts.clear()
}
