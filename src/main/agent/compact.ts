import type { ChatMessage } from '@shared/agent'
import { createProvider } from '../providers'
import { getProvider } from '../store'
import { getConversation, setMessages } from '../conversations'
import {
  KEEP_RECENT_USER_TURNS,
  SUMMARY_MAX_TOKENS,
  buildSummaryMessages,
  buildSummaryRequestMessages,
  findCompactionCut,
  summarizationSystemPrompt
} from './compaction'

export interface CompactResult {
  ok: boolean
  /** Number of messages folded into the summary (0 = nothing to compact). */
  summarized: number
  /** The new message log when something was compacted; undefined otherwise. */
  messages?: ChatMessage[]
  error?: string
}

/**
 * Build the post-compaction message log: the synthetic summary pair followed by
 * the kept tail. Pure, so it's unit-testable without a provider.
 */
export function applyCompaction(messages: ChatMessage[], cut: number, summary: string): ChatMessage[] {
  return [...buildSummaryMessages(summary), ...messages.slice(cut)]
}

/**
 * Compact a conversation on demand (the `/compact` command): summarize the older
 * turns into a dense synthetic exchange and keep the recent ones, then persist.
 * Mirrors the loop's automatic compaction but runs outside a turn.
 */
export async function compactConversationNow(
  id: string,
  providerId: string,
  model: string
): Promise<CompactResult> {
  const conv = getConversation(id)
  if (!conv) return { ok: false, summarized: 0, error: 'Conversation not found.' }

  const cut = findCompactionCut(conv.messages, 0, KEEP_RECENT_USER_TURNS)
  if (cut <= 0) return { ok: true, summarized: 0 }

  const cfg = getProvider(providerId)
  if (!cfg) return { ok: false, summarized: 0, error: `Unknown provider: ${providerId}` }

  let provider
  try {
    provider = createProvider(cfg)
  } catch (e) {
    return { ok: false, summarized: 0, error: (e as Error).message }
  }

  let text = ''
  try {
    for await (const ev of provider.streamChat({
      model,
      system: summarizationSystemPrompt,
      messages: buildSummaryRequestMessages([], conv.messages.slice(0, cut)),
      maxTokens: SUMMARY_MAX_TOKENS
    })) {
      if (ev.type === 'text') text += ev.text
      else if (ev.type === 'error') throw new Error(ev.message)
    }
  } catch (e) {
    return { ok: false, summarized: 0, error: (e as Error).message }
  }

  const summary = text.trim()
  if (!summary) return { ok: false, summarized: 0, error: 'The model returned an empty summary.' }

  const messages = applyCompaction(conv.messages, cut, summary)
  setMessages(id, messages)
  return { ok: true, summarized: cut, messages }
}
