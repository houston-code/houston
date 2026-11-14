import { createHash } from 'node:crypto'
import type { ChatMessage } from '@shared/agent'
import { resolveContextWindow } from '@shared/usage'
import { createProvider } from '../providers'
import { getProvider } from '../agentHost'
import { getConversation, peekConversation, setCompaction, setMessages } from '../conversations'
import { log } from '../logger'
import { activeRunForConversation } from './loop'
import { describeProviderError, providerStreamError, withProviderRetry } from './retry'
import {
  KEEP_RECENT_USER_TURNS,
  SUMMARY_TRUNCATED_MESSAGE,
  buildSummaryMessages,
  buildSummaryRequestMessages,
  estimateTokens,
  findCompactionCutByBudget,
  findSummaryChunkCut,
  summarizationSystemPrompt,
  summaryMaxTokens
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

/**
 * Longest a manual compaction may take overall, retries and every chunk included.
 * Past it the attempt is abandoned with a clear error rather than leaving the user
 * staring at "Compacting" while a struggling provider is retried in silence.
 */
export const COMPACT_DEADLINE_MS = 3 * 60_000

/**
 * Why a compaction did nothing. On success: `empty` / `single-turn` (nothing worth
 * summarizing). On failure: `cancelled` (the user stopped it), `timeout` (it ran past
 * the deadline), `running` (a turn is live, or started, on the chat), `changed` (the
 * chat moved on while the summary was being written, so it would clobber newer
 * messages), `busy` (a compaction of that chat is already in flight).
 */
export type CompactReason = 'empty' | 'single-turn' | 'cancelled' | 'timeout' | 'running' | 'changed' | 'busy'

export interface CompactResult {
  ok: boolean
  /** Number of messages folded into the summary (0 = nothing to compact). */
  summarized: number
  /** The new message log when something was compacted; undefined otherwise. */
  messages?: ChatMessage[]
  /** Why nothing was compacted (see {@link CompactReason}). */
  reason?: CompactReason
  error?: string
}

/** A transient provider failure the compaction is about to retry. */
export interface CompactRetryInfo {
  attempt: number
  /** Undefined while riding out a network outage (a time budget, not a count). */
  max?: number
  error: string
}

export interface CompactOptions {
  /** Aborting it cancels the compaction; nothing is written. */
  signal?: AbortSignal
  /** Overall deadline; defaults to {@link COMPACT_DEADLINE_MS}. */
  deadlineMs?: number
  /** Called before each retry of a failed summarization request. */
  onRetry?: (info: CompactRetryInfo) => void
}

export const COMPACT_ERR_CANCELLED = 'Compaction cancelled.'
export const COMPACT_ERR_RUNNING =
  'A turn is running in this chat. Wait for it to finish (or stop it), then compact.'
export const COMPACT_ERR_CHANGED =
  'The chat changed while it was being compacted, so nothing was replaced. Try /compact again.'
export const COMPACT_ERR_BUSY = 'This chat is already being compacted.'

function timeoutMessage(ms: number): string {
  const mins = Math.round(ms / 60_000)
  const span = mins >= 1 ? `${mins} minute${mins === 1 ? '' : 's'}` : `${Math.round(ms / 1000)} seconds`
  return `Compaction took longer than ${span} and was stopped. Nothing was changed; try again later.`
}

/** Compactions in flight, by conversation id, so the UI can cancel one. */
const inFlight = new Map<string, AbortController>()

/** Whether a compaction of the conversation is in flight. */
export function compactionInProgress(id: string): boolean {
  return inFlight.has(id)
}

/** Cancel the conversation's in-flight compaction. False when there was none. */
export function cancelCompaction(id: string): boolean {
  const ctl = inFlight.get(id)
  if (!ctl) return false
  ctl.abort()
  return true
}

/**
 * A fingerprint of the stored message log, to notice it moved on mid-compaction. The
 * log itself, not `updatedAt`: a settings change bumps that without touching a
 * message. Peeked, so attachments hash as their stored references, not their bytes.
 */
function logStamp(id: string): string | null {
  const conv = peekConversation(id)
  if (!conv) return null
  return `${conv.messages.length}:${createHash('sha256').update(JSON.stringify(conv.messages)).digest('hex')}`
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
  model: string,
  opts: CompactOptions = {}
): Promise<CompactResult> {
  if (inFlight.has(id)) return { ok: false, summarized: 0, reason: 'busy', error: COMPACT_ERR_BUSY }
  if (opts.signal?.aborted) return { ok: false, summarized: 0, reason: 'cancelled', error: COMPACT_ERR_CANCELLED }
  const ctl = new AbortController()
  inFlight.set(id, ctl)
  const onOuterAbort = (): void => ctl.abort()
  opts.signal?.addEventListener('abort', onOuterAbort, { once: true })
  const deadlineMs = opts.deadlineMs ?? COMPACT_DEADLINE_MS
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ctl.abort()
  }, deadlineMs)
  // Settle the moment the signal fires, even when a provider stream ignores it:
  // the work keeps nothing it hasn't written, and it never writes once aborted.
  let release: () => void = () => {}
  const stopped = new Promise<CompactResult>((resolve) => {
    const done = (): void =>
      resolve(
        timedOut
          ? { ok: false, summarized: 0, reason: 'timeout', error: timeoutMessage(deadlineMs) }
          : { ok: false, summarized: 0, reason: 'cancelled', error: COMPACT_ERR_CANCELLED }
      )
    ctl.signal.addEventListener('abort', done, { once: true })
    release = () => ctl.signal.removeEventListener('abort', done)
  })
  try {
    return await Promise.race([stopped, compactUnderSignal(id, providerId, model, ctl.signal, opts.onRetry)])
  } finally {
    release()
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onOuterAbort)
    inFlight.delete(id)
  }
}

async function compactUnderSignal(
  id: string,
  providerId: string,
  model: string,
  signal: AbortSignal,
  onRetry: CompactOptions['onRetry']
): Promise<CompactResult> {
  // A live turn is appending to this log; a summary of it would race those writes.
  if (activeRunForConversation(id)) {
    return { ok: false, summarized: 0, reason: 'running', error: COMPACT_ERR_RUNNING }
  }
  const stamp = logStamp(id)
  const conv = getConversation(id)
  if (!conv) return { ok: false, summarized: 0, error: 'Conversation not found.' }

  const cfg = getProvider(providerId)
  if (!cfg) return { ok: false, summarized: 0, error: `Unknown provider: ${providerId}` }

  // Host-listed capability metadata first, then the family heuristic — the caps
  // are what carry the real window for BYO models the heuristics don't know.
  const window = resolveContextWindow(model, cfg.models?.find((m) => m.id === model)?.caps)
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
      // Each chunk is retried on its own: they fold into a running summary, so losing
      // the whole compaction to a transient blip on the last of them would throw away
      // every chunk before it. Safe to retry in full — the text is accumulated here,
      // not streamed to anyone. A summary cut off at the output cap is an error, not
      // a result: it would replace the head with a summary missing its end.
      const text = await withProviderRetry(async () => {
        let acc = ''
        let truncated = false
        for await (const ev of provider.streamChat({
          model,
          system: summarizationSystemPrompt,
          messages: buildSummaryRequestMessages(summaryMsgs, conv.messages.slice(cut, next)),
          maxTokens: summaryMaxTokens(window),
          signal
        })) {
          if (ev.type === 'text') acc += ev.text
          else if (ev.type === 'done') truncated = ev.stopReason === 'max_tokens'
          else if (ev.type === 'error') throw providerStreamError(ev)
        }
        if (truncated) throw new Error(SUMMARY_TRUNCATED_MESSAGE)
        return acc
      }, {
        signal,
        onRetry: (attempt, err, max) => {
          const error = describeProviderError(err)
          log.warn(`compact: retrying summary request (attempt ${attempt}${max ? ` of ${max}` : ''}): ${error}`)
          if (!signal.aborted) onRetry?.({ attempt, max, error })
        }
      })
      if (signal.aborted) return { ok: false, summarized: 0, error: COMPACT_ERR_CANCELLED }
      const summary = text.trim()
      if (!summary) return { ok: false, summarized: 0, error: 'The model returned an empty summary.' }
      summaryMsgs = buildSummaryMessages(summary)
      cut = next
    }
  } catch (e) {
    return { ok: false, summarized: 0, error: (e as Error).message }
  }
  // Superseded by the caller's abort result; never write after a cancel or timeout.
  if (signal.aborted) return { ok: false, summarized: 0, error: COMPACT_ERR_CANCELLED }
  // The summary took a while: a turn sent meanwhile (or any other rewrite) must win
  // over it, so write only onto the exact log that was summarized.
  if (activeRunForConversation(id)) {
    return { ok: false, summarized: 0, reason: 'running', error: COMPACT_ERR_RUNNING }
  }
  if (logStamp(id) !== stamp) {
    return { ok: false, summarized: 0, reason: 'changed', error: COMPACT_ERR_CHANGED }
  }

  const messages = [...summaryMsgs, ...conv.messages.slice(target)]
  setMessages(id, messages)
  // The rewrite embeds the summary in the log itself, so any loop-persisted
  // compaction state now indexes into the wrong log — clear it rather than let a
  // stale cut drop messages the stored summary never covered. The loop re-persists
  // fresh state the next time it compacts.
  setCompaction(id, null)
  return { ok: true, summarized: target, messages }
}
