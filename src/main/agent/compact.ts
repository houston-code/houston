import type { ChatMessage } from '@shared/agent'
import { contextWindowFor } from '@shared/usage'
import { createProvider } from '../providers'
import { getProvider } from '../agentHost'
import { getConversation, setMessages } from '../conversations'
import {
  KEEP_RECENT_USER_TURNS,
  SUMMARY_MAX_TOKENS,
  buildSummaryMessages,
  buildSummaryRequestMessages,
  estimateTokens,
  findCompactionCutByBudget,
  findSummaryChunkCut,
  summarizationSystemPrompt
} from './compaction'

/**
 * Fraction of the model's context window a single summarization request's input
 * chunk may use. The rest is headroom for the prior summary, the instruction, the
 * system prompt, and the summary output. Keeping each chunk well under the window
 * is what lets `/compact` rescue a conversation that is *already* over the limit.
 */
const SUMMARY_CHUNK_FRACTION = 0.6
const DEFAULT_SUMMARY_CHUNK_BUDGET = 100_000

/**
 * Fraction of the context window the kept (verbatim) tail may occupy after a manual
 * compaction. `/compact` is a deliberate "free up context now" action, so we keep
 * the tail small and summarize everything older — even recent turns, when they're
 * large. Falls back to a fixed budget when the model's window is unknown.
 */
const KEEP_TAIL_FRACTION = 0.3
const DEFAULT_KEEP_TAIL_BUDGET = 50_000

export interface CompactResult {
  ok: boolean
  /** Number of messages folded into the summary (0 = nothing to compact). */
  summarized: number
  /** The new message log when something was compacted; undefined otherwise. */
  messages?: ChatMessage[]
  /** Why nothing was compacted (only set when `summarized` is 0 on success). */
  reason?: 'empty' | 'single-turn'
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

  const window = contextWindowFor(model)
  const keepTailBudget = window ? Math.floor(window * KEEP_TAIL_FRACTION) : DEFAULT_KEEP_TAIL_BUDGET

  // Nothing worth doing if the whole conversation already fits in the tail we'd keep.
  if (estimateTokens('', conv.messages) <= keepTailBudget) {
    return { ok: true, summarized: 0, reason: 'empty' }
  }

  const target = findCompactionCutByBudget(conv.messages, KEEP_RECENT_USER_TURNS, keepTailBudget)
  if (target <= 0) {
    // Distinguish a genuinely tiny chat from one big single turn that simply can't
    // be split at a turn boundary, so the UI can explain rather than mislead.
    const userTurns = conv.messages.filter((m) => m.role === 'user').length
    return { ok: true, summarized: 0, reason: userTurns === 0 ? 'empty' : 'single-turn' }
  }

  const cfg = getProvider(providerId)
  if (!cfg) return { ok: false, summarized: 0, error: `Unknown provider: ${providerId}` }

  let provider
  try {
    provider = createProvider(cfg)
  } catch (e) {
    return { ok: false, summarized: 0, error: (e as Error).message }
  }

  const budget = window ? Math.floor(window * SUMMARY_CHUNK_FRACTION) : DEFAULT_SUMMARY_CHUNK_BUDGET

  // Summarize the head [0, target) in budget-bounded chunks, folding each result
  // into a running summary. Chunking keeps any single summarization request from
  // itself overflowing the window — essential when the conversation is already
  // over the limit, where a one-shot summary of the whole head would just fail.
  let summaryMsgs: ChatMessage[] = []
  let cut = 0
  try {
    while (cut < target) {
      const next = findSummaryChunkCut(conv.messages, cut, target, budget)
      let text = ''
      for await (const ev of provider.streamChat({
        model,
        system: summarizationSystemPrompt,
        messages: buildSummaryRequestMessages(summaryMsgs, conv.messages.slice(cut, next)),
        maxTokens: SUMMARY_MAX_TOKENS
      })) {
        if (ev.type === 'text') text += ev.text
        else if (ev.type === 'error') throw new Error(ev.message)
      }
      const summary = text.trim()
      if (!summary) return { ok: false, summarized: 0, error: 'The model returned an empty summary.' }
      summaryMsgs = buildSummaryMessages(summary)
      cut = next
    }
  } catch (e) {
    return { ok: false, summarized: 0, error: (e as Error).message }
  }

  const messages = [...summaryMsgs, ...conv.messages.slice(target)]
  setMessages(id, messages)
  return { ok: true, summarized: target, messages }
}
