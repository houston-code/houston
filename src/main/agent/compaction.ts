import type { ChatMessage } from '@shared/agent'

/**
 * Context compaction. Long sessions otherwise grow the message log without bound
 * and eventually overflow the model's context window. We keep the full log intact
 * (for persistence and the UI transcript) but, when the *send window* gets large,
 * summarize the older turns into a compact synthetic exchange and send only that
 * summary plus the most recent turns to the provider.
 *
 * The functions here are pure so they can be unit-tested without a provider; the
 * loop drives the one impure step (asking the model to write the summary).
 */

/** Keep this many of the most recent user turns verbatim when compacting. */
export const KEEP_RECENT_USER_TURNS = 3

/** Tokens to allow the summary itself to consume. */
export const SUMMARY_MAX_TOKENS = 2048

export const COMPACTION_SUMMARY_PREFIX =
  'Summary of the earlier conversation (older messages were compacted to save context):'

const COMPACTION_ACK =
  'Understood. I have the summary of the earlier conversation above and will continue from the current state.'

/** System prompt used for the summarization call. */
export const summarizationSystemPrompt = `You are compacting a long coding-assistant conversation so it fits the model's context window. Write a dense, factual summary that lets the assistant continue seamlessly without the original messages. Cover, as compact bullet points:
- the user's goal and any explicit requirements or constraints
- key decisions made and the reasoning behind them
- files inspected or changed, and what changed
- commands run and their important results
- facts learned about the codebase (structure, conventions, gotchas)
- unresolved questions or known issues
- the current state and the next steps

Do not include pleasantries, do not address the user, and do not invent details. If an earlier summary is included, fold it into the new one rather than repeating it.`

const SUMMARY_INSTRUCTION =
  'Produce the summary now, following your instructions. Output only the summary text.'

/**
 * Rough token estimate (~4 characters per token) over the system prompt and the
 * messages that would be sent, plus a small per-message framing overhead. This is
 * deliberately provider-agnostic: it works for local models that report no usage.
 */
export function estimateTokens(system: string, messages: ChatMessage[]): number {
  let chars = system.length
  for (const m of messages) {
    chars += m.content.length
    for (const tc of m.toolCalls ?? []) {
      chars += tc.name.length + JSON.stringify(tc.arguments).length
    }
  }
  return Math.ceil(chars / 4) + messages.length * 4
}

/**
 * Pick the index in `messages` where the kept tail should begin. Everything before
 * it gets summarized; from it onward is sent verbatim. We always cut at a
 * `user`-message boundary (the start of a turn) so the tail is a sequence of whole
 * turns and begins with a `user` message — valid for every provider adapter.
 *
 * Keeps the last `keepRecentUserTurns` user turns. Returns `currentCut` unchanged
 * when there is nothing new to compact (too few turns, or we already cut here).
 */
export function findCompactionCut(
  messages: ChatMessage[],
  currentCut: number,
  keepRecentUserTurns: number
): number {
  const userIdx: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user') userIdx.push(i)
  }
  if (userIdx.length <= keepRecentUserTurns) return currentCut
  const cut = userIdx[userIdx.length - keepRecentUserTurns]
  return cut > currentCut ? cut : currentCut
}

/**
 * Build the messages for the summarization request: any prior summary (so it is
 * folded in rather than lost), then the head being summarized, then an
 * instruction. The head starts at a user boundary and ends at a turn boundary, so
 * appending a final `user` instruction keeps the sequence valid.
 */
export function buildSummaryRequestMessages(
  priorSummary: ChatMessage[],
  head: ChatMessage[]
): ChatMessage[] {
  return [...priorSummary, ...head, { role: 'user', content: SUMMARY_INSTRUCTION }]
}

/**
 * The synthetic user/assistant pair that stands in for the compacted head. Using a
 * pair (not a lone message) keeps role alternation valid and the first sent message
 * a `user` message.
 */
export function buildSummaryMessages(summary: string): ChatMessage[] {
  return [
    { role: 'user', content: `${COMPACTION_SUMMARY_PREFIX}\n\n${summary}` },
    { role: 'assistant', content: COMPACTION_ACK }
  ]
}
