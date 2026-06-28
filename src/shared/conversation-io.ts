import type { ChatMessage, ChatRole, Conversation, ToolCall } from './agent'

/**
 * Validation for imported conversation JSON. Kept Electron-free (and in shared)
 * so it can be unit-tested and reused. The exported file is just a `Conversation`
 * serialized to JSON; on import we trust only the fields below and regenerate the
 * id/timestamps, so a malformed or hostile file can't smuggle in extra state.
 */

export interface ImportedConversation {
  title: string
  messages: ChatMessage[]
  workspace?: string
  providerId?: string
  model?: string
}

/**
 * Caps so a hostile or accidentally-huge import file can't exhaust memory or the
 * renderer. {@link MAX_IMPORT_BYTES} is enforced on the raw file BEFORE it is read
 * (see the import IPC handler); the rest bound the parsed structure as
 * defence-in-depth — over-cap messages are rejected, over-long strings clamped.
 */
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024 // 50 MB on disk
export const MAX_IMPORT_MESSAGES = 50_000
const MAX_CONTENT_CHARS = 1_000_000 // per message
const MAX_TITLE_CHARS = 500
const MAX_TOOL_CALLS = 1_000 // per message
const MAX_TOOL_FIELD_CHARS = 1_000 // tool call id / name

const ROLES: ChatRole[] = ['system', 'user', 'assistant', 'tool']

function str(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key]
  return typeof v === 'string' ? v : undefined
}

/** Truncate an over-long string with a marker, leaving normal strings untouched. */
function clampLen(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…[truncated]` : s
}

export function validateImportedConversation(raw: unknown): ImportedConversation {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Not a conversation file (expected a JSON object).')
  }
  const o = raw as Record<string, unknown>
  if (!Array.isArray(o.messages)) {
    throw new Error('Conversation file has no "messages" array.')
  }
  if (o.messages.length > MAX_IMPORT_MESSAGES) {
    throw new Error(
      `Conversation file has too many messages (${o.messages.length}; max ${MAX_IMPORT_MESSAGES}).`
    )
  }

  const messages: ChatMessage[] = o.messages.map((m, i) => {
    if (typeof m !== 'object' || m === null) throw new Error(`Invalid message at index ${i}.`)
    const mm = m as Record<string, unknown>
    if (typeof mm.role !== 'string' || !ROLES.includes(mm.role as ChatRole)) {
      throw new Error(`Message ${i} has an invalid role.`)
    }
    if (typeof mm.content !== 'string') {
      throw new Error(`Message ${i} is missing string content.`)
    }
    // Keep only the known ChatMessage fields (dropping anything else) and clamp
    // unbounded strings so one giant message can't blow up memory / the renderer.
    const msg: ChatMessage = { role: mm.role as ChatRole, content: clampLen(mm.content, MAX_CONTENT_CHARS) }
    if (Array.isArray(mm.toolCalls)) {
      msg.toolCalls = mm.toolCalls.slice(0, MAX_TOOL_CALLS).map((tc, j): ToolCall => {
        if (typeof tc !== 'object' || tc === null) {
          throw new Error(`Message ${i} tool call ${j} is invalid.`)
        }
        const t = tc as Record<string, unknown>
        if (typeof t.id !== 'string' || typeof t.name !== 'string') {
          throw new Error(`Message ${i} tool call ${j} is missing a string id/name.`)
        }
        // Strip to the known shape; `arguments` must be an object (never executed,
        // but it's sent to the provider as tool_use input).
        const args = typeof t.arguments === 'object' && t.arguments !== null ? t.arguments : {}
        return {
          id: clampLen(t.id, MAX_TOOL_FIELD_CHARS),
          name: clampLen(t.name, MAX_TOOL_FIELD_CHARS),
          arguments: args as Record<string, unknown>
        }
      })
    }
    const toolCallId = str(mm, 'toolCallId')
    if (toolCallId) msg.toolCallId = clampLen(toolCallId, MAX_TOOL_FIELD_CHARS)
    const toolName = str(mm, 'toolName')
    if (toolName) msg.toolName = clampLen(toolName, MAX_TOOL_FIELD_CHARS)
    return msg
  })

  const title = str(o, 'title')
  return {
    title: clampLen(title && title.trim() ? title.trim() : 'Imported chat', MAX_TITLE_CHARS),
    messages,
    workspace: str(o, 'workspace'),
    providerId: str(o, 'providerId'),
    model: str(o, 'model')
  }
}

/**
 * Decide the workspace for an imported conversation. An imported `workspace` is
 * only honored if the user has previously selected it (it appears in recents) —
 * otherwise a shared or hostile import file could silently broaden the macOS
 * sandbox's writable scope to an arbitrary directory (e.g. $HOME or /). Anything
 * untrusted falls back to the most recent workspace (empty string if none, in
 * which case the user picks a folder before the conversation can run).
 */
export function resolveImportWorkspace(
  importedWorkspace: string | undefined,
  recentWorkspaces: string[]
): string {
  if (importedWorkspace && recentWorkspaces.includes(importedWorkspace)) return importedWorkspace
  return recentWorkspaces[0] ?? ''
}

/** Title for a forked conversation: "<base> (fork)", without stacking suffixes. */
export function forkTitle(title: string): string {
  const base = title.replace(/\s*\(fork(?: \d+)?\)\s*$/i, '').trim() || 'Chat'
  return `${base} (fork)`
}

/**
 * Shape a forked conversation from a source: a fresh id + timestamps, a "(fork)"
 * title, and an independent copy of the message log. Pin and group membership are
 * cleared so the fork lands in the default list rather than duplicating a pin.
 * Pure (no fs/electron) so it's unit-testable.
 */
export function forkConversationData(src: Conversation, id: string, now: number): Conversation {
  const fork: Conversation = {
    ...src,
    id,
    title: forkTitle(src.title),
    createdAt: now,
    updatedAt: now,
    messages: src.messages.map((m) => ({ ...m }))
  }
  delete fork.pinned
  delete fork.archived
  delete fork.groupId
  return fork
}
