import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ChatMessage, Conversation } from '@shared/agent'
import { MAX_IMPORT_BYTES, parseConversationFile, type ImportedConversation } from '@shared/conversation-io'

/**
 * `/import <file>` for the terminal: read a chat exported as JSON or HTML (by the
 * desktop app or `/export json`) with the desktop's own parser and size cap, and
 * save it as a new chat. It always lands in the session's own folder, never the one
 * the file names: the file is outside input, and a folder taken from it would widen
 * what the agent may touch. Throws with a message to show on any problem.
 */
export interface ImportChatDeps {
  /** Save the parsed chat as a new conversation in `workspace`. */
  save(data: ImportedConversation, workspace: string): Conversation
  /** Size of the file, in bytes (stat, before anything is read). */
  size?(path: string): number
  read?(path: string): string
}

export interface ImportedChat {
  id: string
  title: string
  messages: ChatMessage[]
  providerId: string
  model: string
  /** Only the visible text came back (an HTML export from before the data block). */
  textOnly: boolean
}

export function importChatFile(cwd: string, path: string, deps: ImportChatDeps): ImportedChat {
  const expanded = path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path
  const full = resolve(cwd, expanded)
  let size: number
  try {
    size = (deps.size ?? ((p) => statSync(p).size))(full)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    throw new Error(code === 'ENOENT' ? `no such file: ${full}` : (e as Error).message, { cause: e })
  }
  // Checked before reading, so a huge file is never loaded into memory.
  if (size > MAX_IMPORT_BYTES) {
    throw new Error(
      `${full} is too large (${Math.round(size / 1_000_000)} MB; max ${Math.round(MAX_IMPORT_BYTES / 1_000_000)} MB)`
    )
  }
  const text = (deps.read ?? ((p) => readFileSync(p, 'utf8')))(full)
  const { data, textOnly } = parseConversationFile(text)
  const conv = deps.save(data, cwd)
  return {
    id: conv.id,
    title: conv.title,
    messages: conv.messages,
    providerId: conv.providerId,
    model: conv.model,
    textOnly
  }
}
