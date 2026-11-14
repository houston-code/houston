import type { ReviewComment } from '@shared/promptInvocation'
import type { FileDiff } from '@shared/workingTree'
import { hunkStart } from '@shared/changes'
import { numberDiff } from '@shared/diff'

/**
 * Line comments left in the Changes view, waiting to be sent to the agent. Kept per
 * chat (and folder) outside React, so they survive the view closing, switching scope,
 * or switching to another chat and back, until they are sent or cleared. Like the
 * composer's unsent draft (composerDraft.ts) they are also saved to localStorage, so a
 * window reload, a renderer crash or a restart doesn't lose them.
 */
export interface DraftComment extends ReviewComment {
  id: string
}

const drafts = new Map<string, DraftComment[]>()

const PREFIX = 'houston.diffComments'
/** More than this many comments for one chat and folder are not saved (the rest stay in memory). */
export const MAX_SAVED_COMMENTS = 500

function storageKey(key: string): string {
  return `${PREFIX}:${encodeURIComponent(key)}`
}

function isDraftComment(v: unknown): v is DraftComment {
  if (!v || typeof v !== 'object') return false
  const c = v as Record<string, unknown>
  return (
    typeof c.id === 'string' &&
    typeof c.path === 'string' &&
    (c.side === 'old' || c.side === 'new') &&
    typeof c.line === 'number' &&
    Number.isInteger(c.line) &&
    typeof c.code === 'string' &&
    typeof c.body === 'string'
  )
}

/** Saved comments for a key; absent, unavailable or malformed storage reads as none. */
function loadSaved(key: string): DraftComment[] {
  try {
    const raw = localStorage.getItem(storageKey(key))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(isDraftComment).slice(0, MAX_SAVED_COMMENTS) : []
  } catch {
    return []
  }
}

function save(key: string, list: DraftComment[]): void {
  try {
    if (list.length === 0) localStorage.removeItem(storageKey(key))
    else localStorage.setItem(storageKey(key), JSON.stringify(list.slice(0, MAX_SAVED_COMMENTS)))
  } catch {
    // Storage full or unavailable: the comments still live in memory for this session.
  }
}

export function draftKey(conversationId: string | null, workspace: string | null): string {
  return `${conversationId ?? ''}\u0000${workspace ?? ''}`
}

export function getDrafts(key: string): DraftComment[] {
  const live = drafts.get(key)
  if (live) return live
  const saved = loadSaved(key)
  if (saved.length) drafts.set(key, saved)
  return saved
}

export function setDrafts(key: string, list: DraftComment[]): void {
  if (list.length === 0) drafts.delete(key)
  else drafts.set(key, list)
  save(key, list)
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

/** Test seam: forgets every draft, in memory and saved. */
export function clearAllDrafts(): void {
  drafts.clear()
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(`${PREFIX}:`)) localStorage.removeItem(k)
  } catch {
    // No storage to clear.
  }
}

/** Test seam: forgets the in-memory drafts only, as a window reload does. */
export function forgetLoadedDrafts(): void {
  drafts.clear()
}
