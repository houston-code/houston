import { existsSync, readFileSync } from 'node:fs'
import type { UnreadInfo, UnreadOutcome } from '@shared/chatStatus'
import { writeFileAtomicSync } from './atomic-write'
import { log } from './logger'

/**
 * Which chats the user hasn't seen since their last turn finished (or marked unread),
 * persisted so the sidebar's unread and failed dots survive a restart.
 *
 * Kept in its own small file rather than on each conversation: writing a conversation
 * bumps its `updatedAt`, which re-sorts the sidebar, so marking a chat read on every
 * open would shuffle the list. Only unread chats have an entry; a read chat is absent,
 * and a missing or corrupt file loads as "everything read" (never a startup failure).
 */

export const READ_STATE_SCHEMA_VERSION = 1

/** Longest note kept on an entry (an error message can be a whole stack). */
export const MAX_NOTE_LENGTH = 120

const OUTCOMES: readonly UnreadOutcome[] = ['done', 'limit', 'error', 'manual']

interface ReadStateFile {
  schemaVersion: number
  unread: Record<string, UnreadInfo>
}

/** One entry from disk, or null when it isn't a well-formed {@link UnreadInfo}. */
function parseEntry(raw: unknown): UnreadInfo | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.since !== 'number' || !Number.isFinite(r.since)) return null
  if (typeof r.outcome !== 'string' || !OUTCOMES.includes(r.outcome as UnreadOutcome)) return null
  const entry: UnreadInfo = { since: r.since, outcome: r.outcome as UnreadOutcome }
  if (typeof r.note === 'string' && r.note) entry.note = clampNote(r.note)
  if (typeof r.anchor === 'number' && Number.isInteger(r.anchor) && r.anchor >= 0) entry.anchor = r.anchor
  return entry
}

/** A note trimmed to one line and {@link MAX_NOTE_LENGTH} characters. */
export function clampNote(note: string): string {
  const line = note.replace(/\s+/g, ' ').trim()
  return line.length > MAX_NOTE_LENGTH ? `${line.slice(0, MAX_NOTE_LENGTH - 1)}…` : line
}

export class ReadStateStore {
  private readonly unread = new Map<string, UnreadInfo>()

  constructor(private readonly path: string) {
    this.load()
  }

  private load(): void {
    if (!existsSync(this.path)) return
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<ReadStateFile>
      // A file from a newer Houston may mean something else by its fields; start clean
      // rather than misread it (it is rewritten on the next change).
      if (typeof raw.schemaVersion !== 'number' || raw.schemaVersion > READ_STATE_SCHEMA_VERSION) return
      for (const [id, value] of Object.entries(raw.unread ?? {})) {
        const entry = parseEntry(value)
        if (entry) this.unread.set(id, entry)
      }
    } catch (err) {
      log.warn(`read-state: unreadable file, treating every chat as read: ${String(err)}`)
    }
  }

  private save(): void {
    const file: ReadStateFile = {
      schemaVersion: READ_STATE_SCHEMA_VERSION,
      unread: Object.fromEntries(this.unread)
    }
    try {
      writeFileAtomicSync(this.path, JSON.stringify(file), 0o600)
    } catch (err) {
      log.warn(`read-state: could not save: ${String(err)}`)
    }
  }

  get(id: string): UnreadInfo | undefined {
    return this.unread.get(id)
  }

  /** Every unread chat, by conversation id. */
  snapshot(): Record<string, UnreadInfo> {
    return Object.fromEntries(this.unread)
  }

  /** Mark a chat unread, replacing any earlier mark (the newest outcome wins). */
  markUnread(id: string, info: UnreadInfo): void {
    const entry: UnreadInfo = { since: info.since, outcome: info.outcome }
    if (info.note) entry.note = clampNote(info.note)
    if (info.anchor !== undefined && Number.isInteger(info.anchor) && info.anchor >= 0) entry.anchor = info.anchor
    this.unread.set(id, entry)
    this.save()
  }

  /** Mark a chat read. Returns whether anything changed. */
  markRead(id: string): boolean {
    if (!this.unread.delete(id)) return false
    this.save()
    return true
  }

  /** Mark every chat read. Returns the ids that were unread. */
  markAllRead(): string[] {
    const ids = [...this.unread.keys()]
    if (ids.length === 0) return ids
    this.unread.clear()
    this.save()
    return ids
  }

  /** Drop entries for chats that no longer exist. Returns whether anything changed. */
  prune(exists: (id: string) => boolean): boolean {
    let changed = false
    for (const id of [...this.unread.keys()]) {
      if (!exists(id)) {
        this.unread.delete(id)
        changed = true
      }
    }
    if (changed) this.save()
    return changed
  }
}
