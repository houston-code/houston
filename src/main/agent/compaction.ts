import {
  COMPACTION_SUMMARY_PREFIX,
  type ChatMessage,
  type ConversationCompaction,
  type ToolSchema
} from '@shared/agent'
import { DEFAULT_COMPACTION_THRESHOLD } from '@shared/defaults'

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

/**
 * Share of the message room (the compaction threshold minus the system prompt and
 * tool schemas, which ride every request) the verbatim tail may occupy after a
 * proactive compaction. Keeping the last few whole turns is preferred, but only
 * while they fit: a run whose current turn alone is huge (one prompt, dozens of
 * file reads) has to be cut inside that turn, or the window never shrinks. Half
 * the room leaves space for the summary and buys enough headroom that the next
 * compaction is many iterations away rather than one.
 */
export const COMPACTION_TAIL_FRACTION = 0.5

/**
 * Fraction of the model's context window at which proactive compaction kicks in.
 * The remaining fifth is headroom for the next turn's growth (tool results, the
 * model's output, attachments) and for the slack in the ~4-chars-per-token
 * estimate, so a turn that lands right at the threshold still fits comfortably.
 */
export const COMPACTION_WINDOW_FRACTION = 0.8

/**
 * The effective compaction threshold in tokens. An explicit setting always wins
 * (0 disables compaction, matching the documented semantics); otherwise the
 * threshold scales to the selected model's context window — a fixed count is
 * mis-sized in both directions for a bring-your-own-model product (far too eager
 * on a 1M-token model, far too late on a 16k local one). When the window is
 * unknown (a custom/local model with no capability metadata) fall back to the
 * fixed default.
 */
export function resolveCompactionThreshold(
  explicit: number | undefined,
  contextWindow: number | null
): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit)) {
    return explicit > 0 ? Math.floor(explicit) : 0
  }
  if (typeof contextWindow === 'number' && contextWindow > 0) {
    return Math.floor(contextWindow * COMPACTION_WINDOW_FRACTION)
  }
  return DEFAULT_COMPACTION_THRESHOLD
}

/**
 * Whether persisted compaction state still applies to this message log. The state
 * was written against the log as it stood: `cut` on a `user`-turn boundary, or on
 * an assistant iteration inside a turn with `anchor` naming that turn's request,
 * and `evictBefore` within the log. A log that has since been rewritten
 * (`/compact`, an import, a hand-edited file) or shifted by intake repair breaks
 * those invariants, and applying a stale cut would silently drop messages the
 * summary never covered. Checked at run start; an invalid state is simply ignored
 * (worst case: one fresh re-summarization).
 */
export function isValidCompactionState(
  state: ConversationCompaction,
  messages: ChatMessage[]
): boolean {
  const { cut, summary, anchor, evictBefore } = state
  if (!Number.isInteger(cut) || cut < 0 || cut >= messages.length) return false
  if (
    evictBefore !== undefined &&
    !(Number.isInteger(evictBefore) && evictBefore > 0 && evictBefore <= messages.length)
  ) {
    return false
  }
  // Nothing summarized: only an eviction watermark makes this state worth keeping.
  if (cut === 0) return evictBefore !== undefined && anchor === undefined
  if (typeof summary !== 'string' || summary.trim() === '') return false
  if (anchor === undefined) return messages[cut].role === 'user'
  return (
    Number.isInteger(anchor) &&
    anchor >= 0 &&
    anchor < cut &&
    messages[anchor].role === 'user' &&
    messages[cut].role === 'assistant'
  )
}

/**
 * Output tokens to allow the summary. Generous on purpose: a long session's summary
 * is the only record of everything compacted away, and on reasoning models (OpenAI
 * Responses, Gemini thinking) the model's thinking spends this same budget before
 * any summary text is written. A summary that hits the cap is rejected rather than
 * kept truncated, so a cap that is too tight disables compaction outright.
 */
export const SUMMARY_MAX_TOKENS = 16_384

/** Floor for {@link summaryMaxTokens}: the cap compaction used before it scaled. */
const SUMMARY_MIN_TOKENS = 2048

/**
 * The summary's output cap for a model with this context window. Scales down for
 * small windows, where some servers reject a request whose prompt plus `max_tokens`
 * exceeds the window; unknown windows get the full cap.
 */
export function summaryMaxTokens(contextWindow: number | null | undefined): number {
  if (!contextWindow || contextWindow <= 0) return SUMMARY_MAX_TOKENS
  return Math.min(SUMMARY_MAX_TOKENS, Math.max(SUMMARY_MIN_TOKENS, Math.floor(contextWindow / 4)))
}

/**
 * Error message for a summary the model stopped at its output cap. A truncated
 * summary loses the tail of what it was summarizing (usually the most recent work
 * and the next steps), so it is treated as a failed compaction, never kept.
 */
export const SUMMARY_TRUNCATED_MESSAGE =
  "The summary was cut off at the model's output limit, so it was discarded."

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
export const summarizationSystemPrompt = `You are compacting a long coding-assistant conversation so it fits the model's context window. Your summary replaces the earlier messages: the assistant will continue from it alone, so it must carry everything needed to keep going without re-asking the user or redoing work. Write a dense, factual summary as compact bullet points covering:
- the user's goal and every explicit requirement, constraint, and preference they stated (keep their wording where it matters)
- key decisions made and the reasoning behind them
- files inspected or changed, and what changed in each
- commands run and their important results, including errors
- approaches that were tried and failed, and why, so they are not repeated
- facts learned about the codebase (structure, conventions, gotchas)
- unresolved questions or known issues
- the current state: what was in progress when the conversation was compacted, and the next steps

Keep exact identifiers verbatim (file paths, function and variable names, commands, error messages, values): they are the hardest details to recover. Do not include pleasantries, do not address the user, and do not invent details. If an earlier summary is included, fold it into the new one rather than repeating it.`

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
    chars += messageChars(m)
    attachmentTokens += messageAttachmentTokens(m)
  }
  return Math.ceil(chars / 4) + messages.length * 4 + attachmentTokens
}

/**
 * Rough token estimate for the tool schemas a request advertises, on the same
 * ~4 characters per token basis as {@link estimateTokens}. The schemas ride along on
 * every request but aren't part of the message window, so callers add this to the
 * window estimate.
 */
export function estimateToolTokens(tools: ToolSchema[]): number {
  return Math.ceil(JSON.stringify(tools).length / 4)
}

/** Text characters a message contributes to the estimate: content plus tool-call JSON. */
function messageChars(m: ChatMessage): number {
  let chars = m.content.length
  for (const tc of m.toolCalls ?? []) chars += tc.name.length + JSON.stringify(tc.arguments).length
  return chars
}

/**
 * Images/documents barely touch `content` but cost real tokens; count them
 * explicitly so the estimate doesn't badly undershoot when a turn carries them.
 */
function messageAttachmentTokens(m: ChatMessage): number {
  return (
    (m.images?.length ?? 0) * IMAGE_TOKENS_ESTIMATE +
    (m.documents?.length ?? 0) * DOCUMENT_TOKENS_ESTIMATE
  )
}

/**
 * `estimateTokens('', messages.slice(from))` for every `from`, from one pass of
 * suffix sums. Cut selection probes many candidate tails of a long log; estimating
 * each from scratch would be quadratic in the log's size.
 */
function tailEstimator(messages: ChatMessage[]): (from: number) => number {
  const n = messages.length
  const chars = new Array<number>(n + 1).fill(0)
  const attachments = new Array<number>(n + 1).fill(0)
  for (let i = n - 1; i >= 0; i--) {
    chars[i] = chars[i + 1] + messageChars(messages[i])
    attachments[i] = attachments[i + 1] + messageAttachmentTokens(messages[i])
  }
  return (from) => {
    const i = Math.min(Math.max(from, 0), n)
    return Math.ceil(chars[i] / 4) + (n - i) * 4 + attachments[i]
  }
}

/** Index of the last `user` message, or -1 when there is none. */
function lastUserIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return i
  }
  return -1
}

/**
 * Every index after `currentCut` where a kept tail may begin, ascending. Two kinds:
 *
 *  - A `user` message at or before `turnStart`: the start of a whole turn. The tail
 *    begins with a user message, so it follows the summary pair directly.
 *  - Inside the turn being answered (after `turnStart`), an `assistant` message that
 *    opens a model iteration, once every tool call before it has its result (so no
 *    `tool_use` is separated from its `tool_result`). The turn's first iteration is
 *    never a candidate: cutting there would fold away nothing but the request, which
 *    is re-sent verbatim anyway (see {@link compactionAnchor}).
 *
 * In-turn cuts are what let a single long prompt (one user message, many tool
 * iterations) be compacted at all; before them it grew until the provider refused
 * it. Cuts after `turnStart` never land on a `user` message (a steer, or a note the
 * loop injected), because the anchored request re-sent ahead of the tail would then
 * sit next to another user message.
 */
export function compactionCandidates(
  messages: ChatMessage[],
  currentCut: number,
  turnStart: number
): number[] {
  if (turnStart < 0) return []
  const out: number[] = []
  const pending = new Set<string>()
  let sawIteration = false
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    let candidate = false
    if (i <= turnStart) {
      candidate = m.role === 'user'
    } else if (m.role === 'assistant') {
      candidate = sawIteration && pending.size === 0 && messages[i - 1].role !== 'assistant'
      sawIteration = true
    }
    if (candidate && i > currentCut) out.push(i)
    if (m.role === 'assistant') {
      pending.clear()
      for (const c of m.toolCalls ?? []) pending.add(c.id)
    } else if (m.role === 'tool' && m.toolCallId) {
      pending.delete(m.toolCallId)
    }
  }
  return out
}

/**
 * The anchor for a new cut: when the kept tail starts inside the turn (on an
 * assistant iteration rather than a user message), the index of the request that
 * opened it, `turnStart`. The loop re-sends that request verbatim between the
 * summary and the tail, so the user's own words are never paraphrased away while
 * the work they asked for is still running, and the tail still follows a user
 * message as every adapter requires. Undefined when the cut starts a whole turn.
 */
export function compactionAnchor(
  messages: ChatMessage[],
  cut: number,
  turnStart: number
): number | undefined {
  if (cut <= 0 || cut >= messages.length || messages[cut].role === 'user') return undefined
  return turnStart >= 0 && turnStart < cut ? turnStart : undefined
}

/**
 * Pick the index in `messages` where the kept tail should begin after a proactive
 * (threshold-driven) compaction. Everything before it gets summarized; from it
 * onward is sent verbatim. Pass a log whose stale tool results are already stubbed
 * when eviction is active: indices line up and sizes then match what is sent.
 *
 * Prefers the classic cut that keeps the last `keepRecentUserTurns` whole turns,
 * as long as that tail fits `tailBudget` tokens. When it doesn't (a few huge turns,
 * or one long turn), it takes the earliest candidate from
 * {@link compactionCandidates} whose tail fits, which can fall inside the current
 * turn, or the latest candidate (keeping only the newest iteration) when none fits.
 * `turnStart` is the user message the run is answering; it defaults to the last
 * user message. Without a budget the classic rule alone applies. Returns
 * `currentCut` unchanged when there is nothing new to compact.
 */
export function findCompactionCut(
  messages: ChatMessage[],
  currentCut: number,
  keepRecentUserTurns: number,
  opts: { turnStart?: number; tailBudget?: number } = {}
): number {
  const turnStart = opts.turnStart ?? lastUserIndex(messages)
  const budget = opts.tailBudget ?? Infinity
  const tail = tailEstimator(messages)
  const fits = (c: number): boolean => tail(c) <= budget

  const turnStarts: number[] = []
  for (let i = 0; i <= turnStart && i < messages.length; i++) {
    if (messages[i].role === 'user') turnStarts.push(i)
  }
  const turnsCut =
    turnStarts.length > keepRecentUserTurns ? turnStarts[turnStarts.length - keepRecentUserTurns] : -1
  if (turnsCut > currentCut && fits(turnsCut)) return turnsCut
  // The tail already fits: whatever is over the threshold, compaction can't shrink it.
  if (fits(currentCut)) return currentCut

  const candidates = compactionCandidates(messages, currentCut, turnStart)
  for (const c of candidates) if (fits(c)) return c
  return candidates.length ? candidates[candidates.length - 1] : currentCut
}

/**
 * Pick the next cut for *forced* compaction: the recovery path taken when the
 * provider rejects a request for exceeding its context window. Halves the verbatim
 * tail (by estimate) with each step, so a run that overflowed recovers in a round
 * or two instead of one summarization per turn or iteration, and each chunk handed
 * to the summarizer stays well inside the window. Always advances at least one
 * candidate, and can cut inside the current turn, so a single long prompt can be
 * rescued too. Never cuts away the turn's request when no iteration has run yet,
 * nor the newest iteration. Returns `currentCut` unchanged when nothing more can be
 * summarized away (what remains overflows on its own; no compaction can save it).
 */
export function findForcedCompactionCut(
  messages: ChatMessage[],
  currentCut: number,
  turnStart: number = lastUserIndex(messages)
): number {
  const candidates = compactionCandidates(messages, currentCut, turnStart)
  if (candidates.length === 0) return currentCut
  const tail = tailEstimator(messages)
  const target = tail(currentCut) / 2
  for (const c of candidates) if (tail(c) <= target) return c
  return candidates[candidates.length - 1]
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
    chars += messageChars(m)
    attachmentTokens += messageAttachmentTokens(m)
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
 * The cut always lands on a `user` boundary (unlike the loop's cuts, which can fall
 * inside a turn), so the kept tail begins a turn and the synthetic summary pair
 * stays valid for every provider when `/compact` rewrites the log with it.
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
 * Build the messages for the summarization request: whatever currently stands in
 * for the already-compacted head (the prior summary, plus an anchored request), so
 * it is folded in rather than lost, then the head being summarized, then an
 * instruction. A head can now start on an assistant iteration or end on a user
 * message (a cut inside a turn), so adjacent plain `user` messages are merged into
 * one: providers that enforce strict alternation reject two in a row.
 */
export function buildSummaryRequestMessages(
  priorSummary: ChatMessage[],
  head: ChatMessage[]
): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const m of [...priorSummary, ...head, { role: 'user', content: SUMMARY_INSTRUCTION } as ChatMessage]) {
    const last = out[out.length - 1]
    if (m.role === 'user' && last?.role === 'user') {
      out[out.length - 1] = mergeUserMessages(last, m)
    } else {
      out.push(m)
    }
  }
  return out
}

/** One user message carrying both inputs' text and attachments (inputs untouched). */
function mergeUserMessages(a: ChatMessage, b: ChatMessage): ChatMessage {
  const images = [...(a.images ?? []), ...(b.images ?? [])]
  const documents = [...(a.documents ?? []), ...(b.documents ?? [])]
  return {
    role: 'user',
    content: [a.content, b.content].filter((c) => c.trim() !== '').join('\n\n'),
    ...(images.length ? { images } : {}),
    ...(documents.length ? { documents } : {})
  }
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
 * Keep the results of the most recent this-many tool-calling iterations verbatim,
 * whatever turn they belong to. Turn age alone never makes anything in the current
 * turn stale, so a single long prompt that reads dozens of files kept every one of
 * them in full until the window overflowed.
 */
export const EVICT_KEEP_RECENT_ITERATIONS = 4

/**
 * Only evict a tool result whose text is at least this many bytes. Small results
 * (a short command's output, a one-line status) cost little context and are worth
 * keeping verbatim; the win is in dropping the large stale ones (a big file read, a
 * verbose build log) whose detail the model has almost certainly moved past.
 */
export const EVICT_MIN_BYTES = 2000

/**
 * Stubbing stale tool results must bring the messages under this share of their
 * room (the compaction threshold minus the system prompt and tool schemas), or the
 * loop summarizes as well. Each eviction rewrites the window (one prompt-cache miss
 * from the first new stub onward); a window left just under the line would cross
 * it again on the next tool call and pay that miss over and over for a sliver of
 * room each time.
 */
export const EVICTION_TARGET_FRACTION = 0.75

export interface EvictionParams {
  /** Turns (from the newest backwards) whose tool results are kept verbatim. */
  keepRecentTurns?: number
  /** Tool-calling iterations (from the newest backwards) whose results are kept verbatim. */
  keepRecentIterations?: number
  /** Minimum byte size for a stale tool result to be replaced by a stub. */
  minBytes?: number
  /**
   * An explicit staleness boundary: tool results at indices before it are eligible.
   * The loop passes its sticky eviction watermark here; when omitted, the boundary
   * comes from turn and iteration age ({@link evictionBoundary}).
   */
  keepFrom?: number
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
  return `[earlier ${tool} result${subj}, ${bytes} bytes elided; recall_history or re-run to view]`
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
 * The index before which a tool result counts as stale: the later of the start of
 * the `keepRecentTurns`-th most recent turn (a turn boundary sits at each `user`
 * message) and the `keepRecentIterations`-th most recent tool-calling iteration.
 * Either age alone makes a result stale, so a long single turn ages its own early
 * reads out. 0 when nothing is old enough by either measure.
 */
export function evictionBoundary(messages: ChatMessage[], params: EvictionParams = {}): number {
  const keepTurns = params.keepRecentTurns ?? EVICT_KEEP_RECENT_TURNS
  const keepIterations = params.keepRecentIterations ?? EVICT_KEEP_RECENT_ITERATIONS
  const userIdx: number[] = []
  const iterationIdx: number[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role === 'user') userIdx.push(i)
    else if (m.role === 'assistant' && (m.toolCalls?.length ?? 0) > 0) iterationIdx.push(i)
  }
  const byTurn = userIdx.length > keepTurns ? userIdx[userIdx.length - keepTurns] : 0
  const byIteration =
    iterationIdx.length > keepIterations ? iterationIdx[iterationIdx.length - keepIterations] : 0
  return Math.max(byTurn, byIteration)
}

/**
 * Whether a tool result would be replaced by a stub: large by text, or carrying an
 * attachment (images/documents have a big real token cost even when the text is
 * short). An already-stubbed result (recall/eviction output) never is, so recall
 * and eviction can't ping-pong.
 */
function isEvictable(m: ChatMessage, minBytes: number): boolean {
  if (m.role !== 'tool') return false
  if (m.content.startsWith('[earlier ')) return false
  const hasAttachment = (m.images?.length ?? 0) > 0 || (m.documents?.length ?? 0) > 0
  return hasAttachment || byteLength(m.content) >= minBytes
}

/**
 * Whether moving the eviction boundary up to `to` would stub anything in
 * `messages[from..to)`. The loop advances its watermark only when this holds, so
 * "something has been evicted" stays true to its word.
 */
export function hasEvictableToolResults(
  messages: ChatMessage[],
  from: number,
  to: number,
  minBytes: number = EVICT_MIN_BYTES
): boolean {
  for (let i = Math.max(0, from); i < Math.min(to, messages.length); i++) {
    if (isEvictable(messages[i], minBytes)) return true
  }
  return false
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
 * "Stale" = before `keepFrom`, which defaults to {@link evictionBoundary} (older
 * than the recent turns or the recent iterations). "Large" = the result text is at
 * least `minBytes` bytes, or it carries an attachment.
 */
export function evictStaleToolResults(
  window: ChatMessage[],
  params: EvictionParams = {}
): ChatMessage[] {
  const minBytes = params.minBytes ?? EVICT_MIN_BYTES
  // Tool results at or after this index are kept verbatim; only earlier ones are
  // eligible for eviction.
  const keepFrom = params.keepFrom ?? evictionBoundary(window, params)
  if (keepFrom <= 0) return window // nothing is old enough to be stale

  // Index assistant tool_use calls by id so a stub can name the tool's subject.
  const callById = new Map<string, { arguments: Record<string, unknown> }>()
  for (const m of window) {
    for (const call of m.toolCalls ?? []) callById.set(call.id, call)
  }

  let changed = false
  const out = window.map((m, i) => {
    if (i >= keepFrom || !isEvictable(m, minBytes)) return m
    changed = true
    const subject = subjectFor(m.toolCallId ? callById.get(m.toolCallId) : undefined)
    const stub: ChatMessage = {
      role: 'tool',
      content: evictionStub(m.toolName, subject, byteLength(m.content)),
      ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
      ...(m.toolName ? { toolName: m.toolName } : {})
    }
    return stub
  })
  return changed ? out : window
}
