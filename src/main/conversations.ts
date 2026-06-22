import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync
} from 'node:fs'
import { join } from 'node:path'
import type { ChatMessage, Conversation, ConversationMeta } from '@shared/agent'

/** Conversations persisted one-JSON-file-per-conversation under userData/conversations. */

function dir(): string {
  const d = join(app.getPath('userData'), 'conversations')
  mkdirSync(d, { recursive: true })
  return d
}

function filePath(id: string): string {
  return join(dir(), `${id}.json`)
}

function read(id: string): Conversation | null {
  const path = filePath(id)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Conversation
  } catch {
    return null
  }
}

function write(conv: Conversation): void {
  const path = filePath(conv.id)
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(conv, null, 2), 'utf8')
  renameSync(tmp, path)
}

export function createConversation(input: {
  workspace: string
  providerId: string
  model: string
}): Conversation {
  const now = Date.now()
  const conv: Conversation = {
    id: randomUUID(),
    title: 'New chat',
    workspace: input.workspace,
    providerId: input.providerId,
    model: input.model,
    createdAt: now,
    updatedAt: now,
    messages: []
  }
  write(conv)
  return conv
}

export function getConversation(id: string): Conversation | null {
  return read(id)
}

export function listConversations(): ConversationMeta[] {
  const files = readdirSync(dir()).filter((f) => f.endsWith('.json'))
  const metas: ConversationMeta[] = []
  for (const f of files) {
    const conv = read(f.replace(/\.json$/, ''))
    if (conv) {
      const { messages: _messages, ...meta } = conv
      metas.push(meta)
    }
  }
  return metas.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function deleteConversation(id: string): void {
  const path = filePath(id)
  if (existsSync(path)) rmSync(path)
}

/** Derive a title from the first user message. */
function deriveTitle(messages: ChatMessage[]): string | null {
  const first = messages.find((m) => m.role === 'user')
  if (!first) return null
  const text = first.content.trim().replace(/\s+/g, ' ')
  return text.length > 60 ? `${text.slice(0, 57)}…` : text || null
}

/** Replace the message log for a conversation and bump updatedAt. */
export function setMessages(id: string, messages: ChatMessage[]): void {
  const conv = read(id)
  if (!conv) return
  conv.messages = messages
  conv.updatedAt = Date.now()
  if (conv.title === 'New chat') {
    const title = deriveTitle(messages)
    if (title) conv.title = title
  }
  write(conv)
}

export function updateConversationMeta(
  id: string,
  patch: Partial<Pick<ConversationMeta, 'providerId' | 'model' | 'title'>>
): void {
  const conv = read(id)
  if (!conv) return
  Object.assign(conv, patch)
  conv.updatedAt = Date.now()
  write(conv)
}
