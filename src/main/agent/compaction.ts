import { COMPACTION_SUMMARY_PREFIX, type ChatMessage } from '@shared/agent'

// Re-exported from shared so existing main-process imports/tests keep their path.
export { COMPACTION_SUMMARY_PREFIX }

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

/**
 * Rough per-attachment token costs. Attachments contribute (almost) nothing to a
 * message's text `content`, so without these the estimate ignores them entirely —
 * a handful of images can silently push the real request past the window. These
 * are deliberately generous (an Anthropic image tops out near ~1600 tokens) so we
 * compact a little early rather than overflow.
 */
export const IMAGE_TOKENS_ESTIMATE = 1600
export const DOCUMENT_TOKENS_ESTIMATE = 3000

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
  let attachmentTokens = 0
  for (const m of messages) {
    chars += m.content.length
    for (const tc of m.toolCalls ?? []) {
      chars += tc.name.length + JSON.stringify(tc.arguments).length
    }
    // Images/documents barely touch `content` but cost real tokens; count them
    // explicitly so the estimate doesn't badly undershoot when a turn carries them.
    attachmentTokens += (m.images?.length ?? 0) * IMAGE_TOKENS_ESTIMATE
    attachmentTokens += (m.documents?.length ?? 0) * DOCUMENT_TOKENS_ESTIMATE
  }
  return Math.ceil(chars / 4) + messages.length * 4 + attachmentTokens
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
 * Pick the next cut for *forced* compaction — the recovery path taken when the
 * provider rejects a request for exceeding its context window. Unlike
 * `findCompactionCut`, which preserves a comfortable tail, this advances the cut
 * by a single user turn at a time, all the way down to keeping only the latest
 * turn. Returns `currentCut` unchanged when nothing more can be summarized away
 * (the latest turn alone overflows — no compaction can save it).
 */
export function findForcedCompactionCut(messages: ChatMessage[], currentCut: number): number {
  let lastUser = -1
  let next = -1
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== 'user') continue
    lastUser = i
    if (next === -1 && i > currentCut) next = i
  }
  // Never cut away the final user turn — that is the request we're trying to send.
  if (next === -1 || next >= lastUser) {
    return lastUser > currentCut ? lastUser : currentCut
  }
  return next
}

/**
 * For incremental summarization of an over-long head, pick the furthest user-turn
 * boundary `cut` in (start, end] whose chunk `messages[start..cut)` is estimated to
 * fit within `budgetTokens`. Always advances by at least one whole turn, so a single
 * turn larger than the budget still makes progress (summarized in its own chunk).
 * This lets a head that is itself bigger than the context window be summarized in
 * pieces, none of which can overflow the window on its own.
 */
export function findSummaryChunkCut(
  messages: ChatMessage[],
  start: number,
  end: number,
  budgetTokens: number
): number {
  let chars = 0
  let attachmentTokens = 0
  let count = 0
  let cut = -1
  let firstBoundary = -1
  for (let i = start; i < end; i++) {
    const m = messages[i]
    chars += m.content.length
    for (const tc of m.toolCalls ?? []) chars += tc.name.length + JSON.stringify(tc.arguments).length
    attachmentTokens += (m.images?.length ?? 0) * IMAGE_TOKENS_ESTIMATE
    attachmentTokens += (m.documents?.length ?? 0) * DOCUMENT_TOKENS_ESTIMATE
    count++
    // A turn boundary sits before a `user` message (the start of a turn) or at `end`.
    const boundary = i + 1
    if (boundary !== end && messages[boundary].role !== 'user') continue
    if (firstBoundary === -1) firstBoundary = boundary
    const size = Math.ceil(chars / 4) + count * 4 + attachmentTokens
    if (size <= budgetTokens) cut = boundary
    else break
  }
  if (cut !== -1) return cut
  return firstBoundary !== -1 ? firstBoundary : end
}

/**
 * Whether a provider error means "the prompt exceeds the model's context window".
 * Wording differs by provider, so match the distinctive phrases:
 *   - Anthropic: "prompt is too long: N tokens > M maximum"
 *   - OpenAI:    "context_length_exceeded" / "maximum context length is N tokens"
 *   - Gemini:    "the input token count ... exceeds the maximum number of tokens"
 * All three report it as a 400; the status guard keeps the broad "exceeds…tokens"
 * alternative from matching an unrelated server-side message.
 */
export function isContextOverflowError(err: unknown): boolean {
  const status = (err as { status?: number })?.status
  if (typeof status === 'number' && status !== 400 && status !== 422) return false
  const msg = String((err as { message?: unknown })?.message ?? err).toLowerCase()
  return /prompt is too long|context[ _-]?length|context[ _-]?window|context_length_exceeded|maximum context|too many tokens|token count[^.]*exceed|exceed[^.]*(?:context|tokens?|maximum)|reduce the (?:length|number of (?:messages|tokens))/.test(
    msg
  )
}

/**
 * Pick a compaction cut by *token budget* rather than by counting whole user turns.
 * Keeps as many of the most recent user turns as fit within `keepTailTokens` (never
 * more than `maxKeepTurns`), but always keeps at least one whole turn and always
 * leaves at least one earlier turn to summarize. This is what lets a long
 * conversation with only two or three (large) user turns still be compacted —
 * `findCompactionCut`'s fixed "keep the last 3 turns" rule refuses to compact those
 * even when they're huge. Returns 0 when there's nothing to summarize away (a
 * single user turn — it can't be split at a turn boundary).
 *
 * Like `findCompactionCut`, the cut always lands on a `user` boundary, so the kept
 * tail begins a turn and the synthetic summary pair stays valid for every provider.
 */
export function findCompactionCutByBudget(
  messages: ChatMessage[],
  maxKeepTurns: number,
  keepTailTokens: number
): number {
  const userIdx: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user') userIdx.push(i)
  }
  if (userIdx.length <= 1) return 0 // one turn (or none) — nothing earlier to fold away
  // Keep at most maxKeepTurns, and always leave >=1 turn for the head to summarize.
  const maxKeep = Math.min(maxKeepTurns, userIdx.length - 1)
  // Default to keeping just the last turn (smallest tail); widen to the largest
  // number of recent turns whose tail still fits the budget.
  let cut = userIdx[userIdx.length - 1]
  for (let keep = maxKeep; keep >= 1; keep--) {
    const start = userIdx[userIdx.length - keep]
    if (estimateTokens('', messages.slice(start)) <= keepTailTokens) {
      cut = start
      break
    }
  }
  return cut
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

// ---- Tool-result eviction ----

/**
 * Keep tool results from the most recent this-many turns (a "turn" starts at a
 * `user` message) verbatim; older ones are eligible for eviction. Three turns is
 * enough that the model still sees the full detail of what it just did.
 */
export const EVICT_KEEP_RECENT_TURNS = 3

/**
 * Only evict a tool result whose text is at least this many bytes. Small results
 * (a short command's output, a one-line status) cost little context and are worth
 * keeping verbatim; the win is in dropping the large stale ones (a big file read, a
 * verbose build log) whose detail the model has almost certainly moved past.
 */
export const EVICT_MIN_BYTES = 2000

export interface EvictionParams {
  /** Turns (from the newest backwards) whose tool results are kept verbatim. */
  keepRecentTurns?: number
  /** Minimum byte size for a stale tool result to be replaced by a stub. */
  minBytes?: number
}

/** UTF-8 byte length of a string (multibyte-safe, matches the provider's accounting). */
function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * The compact stub that replaces an evicted tool result. Names the tool and a short
 * subject so the model knows what it lost and how to get it back — `recall_history`
 * pages the pre-eviction transcript, or it can simply re-run the tool.
 */
export function evictionStub(toolName: string | undefined, subject: string, bytes: number): string {
  const tool = toolName?.trim() || 'tool'
  const subj = subject.trim() ? ` on ${subject.trim()}` : ''
  return `[earlier ${tool} result${subj}, ${bytes} bytes elided — recall_history or re-run to view]`
}

/**
 * A short subject line for a tool result, recovered from the assistant `tool_use`
 * that requested it: the `path`, `pattern`, `query`, `command`, or `url` argument.
 * Empty when nothing usable is found (the stub then omits the subject clause).
 */
function subjectFor(call: { arguments: Record<string, unknown> } | undefined): string {
  if (!call) return ''
  const args = call.arguments
  for (const key of ['path', 'file', 'pattern', 'query', 'command', 'cmd', 'url']) {
    const v = args[key]
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 120)
  }
  return ''
}

/**
 * Replace STALE + LARGE tool results in a sent window with a compact stub, keeping
 * recent and small ones verbatim. This is a more surgical alternative to whole-turn
 * compaction: it shrinks the big, low-value tool outputs the model has moved past
 * while leaving every other message (including the assistant `tool_use` that asked
 * for the result) exactly in place — so role alternation and `toolCallId` pairing
 * stay valid, and no dangling `tool_use` is created.
 *
 * PURE: returns a NEW array; the input (and the persisted log it comes from) is
 * never mutated. Only the ephemeral copy sent to the provider is affected, so the
 * transcript, fork/export, and future compaction still see the full results. The
 * evicted result's attachments (images/documents) are dropped too — they are the
 * bulk of a stale read's real token cost.
 *
 * "Stale" = belongs to a turn older than the most recent `keepRecentTurns` turns.
 * "Large" = the result text is at least `minBytes` bytes. An already-stubbed result
 * (recall/eviction output) is left alone so recall + eviction can't ping-pong.
 */
export function evictStaleToolResults(
  window: ChatMessage[],
  params: EvictionParams = {}
): ChatMessage[] {
  const keepRecentTurns = params.keepRecentTurns ?? EVICT_KEEP_RECENT_TURNS
  const minBytes = params.minBytes ?? EVICT_MIN_BYTES

  // Find the index where the "recent" tail begins: the start of the k-th-from-last
  // turn (a turn boundary sits at each `user` message). Tool results at or after
  // this index are kept verbatim; only earlier ones are eligible for eviction.
  const userIdx: number[] = []
  for (let i = 0; i < window.length; i++) {
    if (window[i].role === 'user') userIdx.push(i)
  }
  const keepFrom =
    userIdx.length > keepRecentTurns ? userIdx[userIdx.length - keepRecentTurns] : 0
  if (keepFrom === 0) return window // nothing is old enough to be stale

  // Index assistant tool_use calls by id so a stub can name the tool's subject.
  const callById = new Map<string, { arguments: Record<string, unknown> }>()
  for (const m of window) {
    for (const call of m.toolCalls ?? []) callById.set(call.id, call)
  }

  let changed = false
  const out = window.map((m, i) => {
    if (i >= keepFrom) return m
    if (m.role !== 'tool') return m
    if (m.content.startsWith('[earlier ')) return m // already a stub — don't re-elide
    const bytes = byteLength(m.content)
    const hasAttachment = (m.images?.length ?? 0) > 0 || (m.documents?.length ?? 0) > 0
    // Attachments have a big real token cost even when the result text is short;
    // evict a tool result that is large by text OR carries any attachment.
    if (bytes < minBytes && !hasAttachment) return m
    changed = true
    const subject = subjectFor(m.toolCallId ? callById.get(m.toolCallId) : undefined)
    const stub: ChatMessage = {
      role: 'tool',
      content: evictionStub(m.toolName, subject, bytes),
      ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
      ...(m.toolName ? { toolName: m.toolName } : {})
    }
    return stub
  })
  return changed ? out : window
}
