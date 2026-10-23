import { existsSync, readFileSync, statSync } from 'node:fs'
import { writeFileAtomicSync } from './atomic-write'
import { log } from './logger'

/**
 * The chat the window showed last, persisted so a relaunch reopens it instead of an
 * empty new chat.
 *
 * Kept in its own small file rather than in settings.json: it changes on every chat
 * switch, and the renderer saves whole settings objects, so a copy it read earlier
 * would write an old value back. A missing or corrupt file loads as "no chat", which
 * is today's launch: a new chat in the last folder.
 */

export const LAST_CHAT_SCHEMA_VERSION = 1

interface LastChatFile {
  schemaVersion: number
  /** The open chat's id, or null when the window was on a new chat. */
  conversationId: string | null
}

export class LastChatStore {
  private id: string | null = null

  constructor(private readonly path: string) {
    this.load()
  }

  private load(): void {
    if (!existsSync(this.path)) return
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<LastChatFile>
      if (typeof raw.schemaVersion !== 'number' || raw.schemaVersion > LAST_CHAT_SCHEMA_VERSION) return
      if (typeof raw.conversationId === 'string' && raw.conversationId) this.id = raw.conversationId
    } catch (err) {
      log.warn(`last-chat: unreadable file, starting on a new chat: ${String(err)}`)
    }
  }

  get(): string | null {
    return this.id
  }

  /** Remember the open chat (null: a new chat). Writes only when it changes. */
  set(id: string | null): void {
    if (id === this.id) return
    this.id = id
    const file: LastChatFile = { schemaVersion: LAST_CHAT_SCHEMA_VERSION, conversationId: id }
    try {
      writeFileAtomicSync(this.path, JSON.stringify(file), 0o600)
    } catch (err) {
      log.warn(`last-chat: could not save: ${String(err)}`)
    }
  }
}

/**
 * The chat to open at launch: the remembered one, if it still exists and its folder
 * (a worktree chat's worktree) is still there. Null means open a new chat, as before.
 */
export function launchChat(
  savedId: string | null,
  workspaceOf: (id: string) => string | null | undefined,
  isDirectory: (path: string) => boolean
): string | null {
  if (!savedId) return null
  const workspace = workspaceOf(savedId)
  if (!workspace || !isDirectory(workspace)) return null
  return savedId
}

/** Whether `path` is a directory, false when it is missing or unreadable. */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
