import type { AgentEvent, ChatMessage } from '@shared/agent'

/** Display model for the transcript, built from streamed AgentEvents or saved messages. */

export type ToolStatus = 'awaiting-approval' | 'running' | 'done' | 'error' | 'denied'

export interface UserItem {
  kind: 'user'
  id: string
  text: string
}
export interface AssistantItem {
  kind: 'assistant'
  id: string
  text: string
  streaming: boolean
  /** Model reasoning ("thinking") streamed before the answer, if any. */
  reasoning?: string
}
export interface ToolItem {
  kind: 'tool'
  id: string // callId
  name: string
  summary?: string
  args?: Record<string, unknown>
  toolKind?: 'read' | 'write' | 'shell' | 'network'
  status: ToolStatus
  output?: string
}
export interface NoticeItem {
  kind: 'notice'
  id: string
  text: string
  tone: 'error' | 'info'
}

export type DisplayItem = UserItem | AssistantItem | ToolItem | NoticeItem

let counter = 0
const nextId = (): string => `i${Date.now().toString(36)}-${counter++}`

function finalizeStreaming(items: DisplayItem[]): DisplayItem[] {
  const last = items[items.length - 1]
  if (last && last.kind === 'assistant' && last.streaming) {
    return [...items.slice(0, -1), { ...last, streaming: false }]
  }
  return items
}

function updateTool(items: DisplayItem[], callId: string, patch: Partial<ToolItem>): DisplayItem[] {
  return items.map((it) => (it.kind === 'tool' && it.id === callId ? { ...it, ...patch } : it))
}

/** Fold one streamed agent event into the display list. */
export function reduceEvent(items: DisplayItem[], e: AgentEvent): DisplayItem[] {
  switch (e.type) {
    case 'text': {
      const last = items[items.length - 1]
      if (last && last.kind === 'assistant' && last.streaming) {
        return [...items.slice(0, -1), { ...last, text: last.text + e.delta }]
      }
      return [...items, { kind: 'assistant', id: nextId(), text: e.delta, streaming: true }]
    }
    case 'reasoning': {
      const last = items[items.length - 1]
      if (last && last.kind === 'assistant' && last.streaming) {
        return [...items.slice(0, -1), { ...last, reasoning: (last.reasoning ?? '') + e.delta }]
      }
      return [...items, { kind: 'assistant', id: nextId(), text: '', streaming: true, reasoning: e.delta }]
    }
    case 'tool_approval': {
      const finalized = finalizeStreaming(items)
      return [
        ...finalized,
        {
          kind: 'tool',
          id: e.callId,
          name: e.name,
          summary: e.summary,
          toolKind: e.kind,
          status: 'awaiting-approval'
        }
      ]
    }
    case 'tool_start': {
      const finalized = finalizeStreaming(items)
      const exists = finalized.some((it) => it.kind === 'tool' && it.id === e.callId)
      if (exists) return updateTool(finalized, e.callId, { status: 'running', args: e.args })
      return [
        ...finalized,
        { kind: 'tool', id: e.callId, name: e.name, args: e.args, status: 'running' }
      ]
    }
    case 'tool_result': {
      const status: ToolStatus = e.ok
        ? 'done'
        : e.output.startsWith('Denied') || e.output.startsWith('Blocked')
          ? 'denied'
          : 'error'
      return updateTool(items, e.callId, { status, output: e.output })
    }
    case 'compaction': {
      const finalized = finalizeStreaming(items)
      return [
        ...finalized,
        {
          kind: 'notice',
          id: nextId(),
          text: `🗜 Compacted ${e.summarized} earlier message${e.summarized === 1 ? '' : 's'} to stay within the context window.`,
          tone: 'info'
        }
      ]
    }
    case 'done': {
      const finalized = finalizeStreaming(items)
      if (e.stopReason === 'aborted') {
        return [...finalized, { kind: 'notice', id: nextId(), text: 'Stopped.', tone: 'info' }]
      }
      return finalized
    }
    case 'error': {
      const finalized = finalizeStreaming(items)
      return [...finalized, { kind: 'notice', id: nextId(), text: e.message, tone: 'error' }]
    }
    default:
      return items
  }
}

/** Build display items from a saved conversation's message log. */
export function itemsFromMessages(messages: ChatMessage[]): DisplayItem[] {
  const resultByCallId = new Map<string, { output: string }>()
  for (const m of messages) {
    if (m.role === 'tool' && m.toolCallId) resultByCallId.set(m.toolCallId, { output: m.content })
  }

  const items: DisplayItem[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      if (m.content.trim()) items.push({ kind: 'user', id: nextId(), text: m.content })
    } else if (m.role === 'assistant') {
      const reasoning = m.reasoning?.map((r) => r.text).filter(Boolean).join('\n') || undefined
      if (m.content.trim() || reasoning) {
        items.push({ kind: 'assistant', id: nextId(), text: m.content, streaming: false, reasoning })
      }
      for (const tc of m.toolCalls ?? []) {
        const res = resultByCallId.get(tc.id)
        const output = res?.output
        const status: ToolStatus = !output
          ? 'done'
          : output.startsWith('Denied') || output.startsWith('Blocked')
            ? 'denied'
            : output.startsWith('Error:')
              ? 'error'
              : 'done'
        items.push({
          kind: 'tool',
          id: tc.id,
          name: tc.name,
          args: tc.arguments,
          status,
          output
        })
      }
    }
  }
  return items
}
