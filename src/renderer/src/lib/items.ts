import {
  COMPACTION_SUMMARY_PREFIX,
  type AgentEvent,
  type ChatMessage,
  type QuestionOption
} from '@shared/agent'
import { ASK_USER_TOOL } from '@shared/constants'
import type { ImageAttachment } from '@shared/images'
import { prNoticeFromToolResult, prNoticeText } from '@shared/prNotice'

/** Display model for the transcript, built from streamed AgentEvents or saved messages. */

export type ToolStatus = 'awaiting-approval' | 'running' | 'done' | 'error' | 'denied'

export interface UserItem {
  kind: 'user'
  id: string
  text: string
  images?: ImageAttachment[]
  /**
   * True for the synthetic summary turn written by context compaction. Its body is
   * model-authored markdown, so the transcript renders it through `Markdown` rather
   * than as plain user text.
   */
  isSummary?: boolean
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
  toolKind?: 'read' | 'write' | 'shell' | 'network' | 'mcp'
  status: ToolStatus
  output?: string
  /** Latest progress line from a long-running tool (e.g. a review's current phase). */
  progress?: string
  /** Images the tool produced (e.g. a view_localhost screenshot). */
  images?: ImageAttachment[]
}
export interface NoticeItem {
  kind: 'notice'
  id: string
  text: string
  tone: 'error' | 'info'
}
export interface QuestionItem {
  kind: 'question'
  id: string // callId
  question: string
  options: QuestionOption[]
  multiSelect?: boolean
  /** The user's answer once given; undefined while the question is still open. */
  answer?: string
}

export type DisplayItem = UserItem | AssistantItem | ToolItem | NoticeItem | QuestionItem

/**
 * The text of the most recent real user turn, or undefined if there is none.
 * Skips the synthetic compaction-summary turn (it's model-authored, not something
 * the user typed) — used to recall the last message into the composer (Esc Esc).
 */
export function lastUserText(items: DisplayItem[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it.kind === 'user' && !it.isSummary) return it.text
  }
  return undefined
}

/** Parse a tool call's `options` argument into display options (string[] or {label,…}[]). */
function optionsFromArgs(raw: unknown): QuestionOption[] {
  if (!Array.isArray(raw)) return []
  const out: QuestionOption[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      if (item.trim()) out.push({ label: item.trim() })
    } else if (item && typeof item === 'object') {
      const rec = item as Record<string, unknown>
      const label = typeof rec.label === 'string' ? rec.label.trim() : ''
      if (!label) continue
      const description = typeof rec.description === 'string' ? rec.description.trim() : ''
      out.push(description ? { label, description } : { label })
    }
  }
  return out
}

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
      // ask_user surfaces as an interactive question card (below), not a tool row.
      if (e.name === ASK_USER_TOOL) return finalized
      const exists = finalized.some((it) => it.kind === 'tool' && it.id === e.callId)
      if (exists) return updateTool(finalized, e.callId, { status: 'running', args: e.args })
      return [
        ...finalized,
        { kind: 'tool', id: e.callId, name: e.name, args: e.args, status: 'running' }
      ]
    }
    case 'tool_progress': {
      // Update the live progress line on the running tool (no-op if it's gone).
      return updateTool(items, e.callId, { progress: e.message })
    }
    case 'tool_question': {
      const finalized = finalizeStreaming(items)
      return [
        ...finalized,
        {
          kind: 'question',
          id: e.callId,
          question: e.question,
          options: e.options,
          ...(e.multiSelect ? { multiSelect: true } : {})
        }
      ]
    }
    case 'tool_result': {
      // An ask_user result carries the answer — fold it into the question card.
      if (e.name === ASK_USER_TOOL) {
        return items.map((it) =>
          it.kind === 'question' && it.id === e.callId ? { ...it, answer: e.output } : it
        )
      }
      const status: ToolStatus = e.ok
        ? 'done'
        : e.output.startsWith('Denied') || e.output.startsWith('Blocked')
          ? 'denied'
          : 'error'
      const updated = updateTool(items, e.callId, {
        status,
        output: e.output,
        progress: undefined, // clear the live progress line now the tool has finished
        ...(e.images?.length ? { images: e.images } : {})
      })
      // Highlight a PR opening/merging as its own notice, above the tool row.
      const pr = prNoticeFromToolResult(e.name, e.ok, e.output)
      if (pr) {
        return [...updated, { kind: 'notice', id: nextId(), text: prNoticeText(pr), tone: 'info' }]
      }
      return updated
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
    case 'retry': {
      const finalized = finalizeStreaming(items)
      return [
        ...finalized,
        {
          kind: 'notice',
          id: nextId(),
          text: `⟳ Connection issue, retrying (${e.attempt}/${e.max})… — ${e.message}`,
          tone: 'info'
        }
      ]
    }
    case 'limit': {
      const finalized = finalizeStreaming(items)
      const text =
        e.reason === 'max-steps'
          ? '⚠ Reached the step limit for one turn and stopped — send a message to have me continue.'
          : '⚠ The reply was cut off at the model’s output limit — ask me to continue it.'
      return [...finalized, { kind: 'notice', id: nextId(), text, tone: 'error' }]
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
  const resultByCallId = new Map<string, { output: string; images?: ImageAttachment[] }>()
  for (const m of messages) {
    if (m.role === 'tool' && m.toolCallId) {
      resultByCallId.set(m.toolCallId, { output: m.content, images: m.images })
    }
  }

  const items: DisplayItem[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      if (m.content.trim() || m.images?.length) {
        items.push({
          kind: 'user',
          id: nextId(),
          text: m.content,
          ...(m.images?.length ? { images: m.images } : {}),
          ...(m.content.startsWith(COMPACTION_SUMMARY_PREFIX) ? { isSummary: true } : {})
        })
      }
    } else if (m.role === 'assistant') {
      const reasoning = m.reasoning?.map((r) => r.text).filter(Boolean).join('\n') || undefined
      if (m.content.trim() || reasoning) {
        items.push({ kind: 'assistant', id: nextId(), text: m.content, streaming: false, reasoning })
      }
      for (const tc of m.toolCalls ?? []) {
        const res = resultByCallId.get(tc.id)
        // ask_user is shown as a (now-answered) question card, not a tool row.
        if (tc.name === ASK_USER_TOOL) {
          items.push({
            kind: 'question',
            id: tc.id,
            question: typeof tc.arguments.question === 'string' ? tc.arguments.question : '',
            options: optionsFromArgs(tc.arguments.options),
            ...(tc.arguments.multiSelect === true ? { multiSelect: true } : {}),
            ...(res?.output ? { answer: res.output } : {})
          })
          continue
        }
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
          output,
          ...(res?.images?.length ? { images: res.images } : {})
        })
        // Mirror the live transcript: a PR opening/merging gets its own notice.
        const pr = output ? prNoticeFromToolResult(tc.name, status === 'done', output) : null
        if (pr) {
          items.push({ kind: 'notice', id: nextId(), text: prNoticeText(pr), tone: 'info' })
        }
      }
    }
  }
  return items
}
