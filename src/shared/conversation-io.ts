import type { ChatMessage, ChatRole, ToolCall } from './agent'

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

const ROLES: ChatRole[] = ['system', 'user', 'assistant', 'tool']

function str(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key]
  return typeof v === 'string' ? v : undefined
}

export function validateImportedConversation(raw: unknown): ImportedConversation {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Not a conversation file (expected a JSON object).')
  }
  const o = raw as Record<string, unknown>
  if (!Array.isArray(o.messages)) {
    throw new Error('Conversation file has no "messages" array.')
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
    // Keep only the known ChatMessage fields; drop anything else.
    const msg: ChatMessage = { role: mm.role as ChatRole, content: mm.content }
    if (Array.isArray(mm.toolCalls)) {
      msg.toolCalls = mm.toolCalls.map((tc, j): ToolCall => {
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
        return { id: t.id, name: t.name, arguments: args as Record<string, unknown> }
      })
    }
    const toolCallId = str(mm, 'toolCallId')
    if (toolCallId) msg.toolCallId = toolCallId
    const toolName = str(mm, 'toolName')
    if (toolName) msg.toolName = toolName
    return msg
  })

  const title = str(o, 'title')
  return {
    title: title && title.trim() ? title.trim() : 'Imported chat',
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
