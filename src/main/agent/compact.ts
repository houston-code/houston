import { createHash } from 'node:crypto'
import type { ChatMessage, RewindBackup } from '@shared/agent'
import { compactionAfterTruncate, rewindableTurnIndices, turnText } from '@shared/rewind'
import { smallModelFor, withSmallModel } from '@shared/smallModel'
import { resolveContextWindow } from '@shared/usage'
import { createProvider } from '../providers'
import { folderTrustState, type Hook } from '@shared/types'
import { collectSecrets, getProvider, getSettings } from '../agentHost'
import {
  conversationFilePath,
  flushConversation,
  getConversation,
  peekConversation,
  setCompaction,
  setMessages,
  writeRewind
} from '../conversations'
import { withRewindLock } from './rewindLock'
import { compactionController, compactionInProgress, holdCompaction, releaseCompaction } from './compactionLock'
import { log } from '../logger'
import { activeRunForConversation } from './loop'
import { memoryTaintSource } from './memoryTools'
import { getTool } from './tools'
import { describeProviderError, providerStreamError, withProviderRetry } from './retry'
import { runHooks, type HookSession } from './hooks'
import { loadProjectConfig } from './projectConfig'
import { createSecretRedactor } from './redact'
import {
  KEEP_RECENT_USER_TURNS,
  SUMMARY_TRUNCATED_MESSAGE,
  buildSummaryMessages,
  buildSummaryRequestMessages,
  estimateTokens,
  findCompactionCutByBudget,
  findSummaryChunkCut,
  isValidCompactionState,
  summarizationSystemPrompt,
  summaryChunkBudget,
  summaryFits,
  summaryMaxTokens
} from './compaction'

/**
 * Fraction of the context window the kept (verbatim) tail may occupy after a manual
 * compaction. `/compact` is a deliberate "free up context now" action, so we keep
 * the tail small and summarize everything older — even recent turns, when they're
 * large. Falls back to a fixed budget when the model's window is unknown.
 */
const KEEP_TAIL_FRACTION = 0.3
const DEFAULT_KEEP_TAIL_BUDGET = 50_000

/**
 * Longest a manual compaction may go without finishing a summary chunk, retries
 * included. Past it the attempt is abandoned with a clear error rather than leaving
 * the user staring at "Compacting" while a struggling provider is retried in silence.
 * Per chunk, not overall: a chat large enough to need many chunks is exactly the one
 * `/compact` must rescue, and one fixed budget for all of them gave up on it while
 * it was still making progress.
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
  /** How long a chunk may take; defaults to {@link COMPACT_DEADLINE_MS}. */
  deadlineMs?: number
  /** Called before each retry of a failed summarization request. */
  onRetry?: (info: CompactRetryInfo) => void
  /** What the summary should focus on (`/compact <focus>`); see normalizeCompactFocus. */
  focus?: string
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
  return `Summarizing part of the chat took longer than ${span}, so the compaction was stopped. Nothing was changed; try again later.`
}

export { compactionInProgress }

/** Cancel the conversation's in-flight compaction. False when there was none. */
export function cancelCompaction(id: string): boolean {
  const ctl = compactionController(id)
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
  return [...buildSummaryMessages(summary, headTaint(messages, cut)), ...messages.slice(cut)]
}

/**
 * The taint of the messages a rewrite drops (`messages[from..cut)`), to carry onto the
 * summary that replaces them (see buildSummaryMessages). A prior summary at the head
 * carries its own, so the taint survives any number of compactions.
 */
function headTaint(messages: ChatMessage[], cut: number, from = 0): string | null {
  return memoryTaintSource(messages.slice(from, cut), (n) => getTool(n)?.kind)
}

/**
 * Compact a conversation on demand (the `/compact` command): summarize the older
 * turns into a dense synthetic exchange and keep the recent ones, then persist.
 * Mirrors the loop's automatic compaction but runs outside a turn.
 */
export function compactConversationNow(
  id: string,
  providerId: string,
  model: string,
  opts: CompactOptions = {}
): Promise<CompactResult> {
  return underCompactionGuard(id, opts, (signal, progress) =>
    compactUnderSignal(id, providerId, model, signal, progress, opts.onRetry, opts.focus)
  )
}

/**
 * Run a summarizing rewrite of chat `id` the way `/compact` runs: one per chat at a
 * time, cancelled by `opts.signal`, abandoned once a chunk runs past the deadline
 * (`work` calls `progress` as each one lands, which restarts it), and settled the
 * moment either fires even when a provider stream ignores the abort.
 */
async function underCompactionGuard(
  id: string,
  opts: CompactOptions,
  work: (signal: AbortSignal, progress: () => void) => Promise<CompactResult>
): Promise<CompactResult> {
  if (compactionInProgress(id)) return { ok: false, summarized: 0, reason: 'busy', error: COMPACT_ERR_BUSY }
  if (opts.signal?.aborted) return { ok: false, summarized: 0, reason: 'cancelled', error: COMPACT_ERR_CANCELLED }
  const ctl = new AbortController()
  holdCompaction(id, ctl)
  const onOuterAbort = (): void => ctl.abort()
  opts.signal?.addEventListener('abort', onOuterAbort, { once: true })
  const deadlineMs = opts.deadlineMs ?? COMPACT_DEADLINE_MS
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = (): void => {
    clearTimeout(timer)
    if (ctl.signal.aborted) return
    timer = setTimeout(() => {
      timedOut = true
      ctl.abort()
    }, deadlineMs)
  }
  arm()
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
    return await Promise.race([stopped, work(ctl.signal, arm)])
  } finally {
    release()
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onOuterAbort)
    releaseCompaction(id)
  }
}

async function compactUnderSignal(
  id: string,
  providerId: string,
  model: string,
  signal: AbortSignal,
  progress: () => void,
  onRetry: CompactOptions['onRetry'],
  focus: string | undefined
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

  // The loop's own summary of the head, when it still holds for this log, stands in
  // for messages[0..cut): start from it rather than re-summarizing a head that a long
  // chat may hold hundreds of thousands of tokens of. Not with a focus, which asks for
  // detail the loop's summary was never written to keep.
  const saved = conv.compaction
  const resume =
    !focus &&
    saved &&
    saved.cut > 0 &&
    saved.anchor === undefined &&
    saved.cut < target &&
    isValidCompactionState(saved, conv.messages)
      ? saved
      : null
  const from = resume ? resume.cut : 0
  const prior = resume ? buildSummaryMessages(resume.summary, headTaint(conv.messages, resume.cut)) : []

  let summaryMsgs: ChatMessage[]
  try {
    summaryMsgs = await summarizeSpan(
      conv.messages,
      from,
      target,
      {
        cfg,
        provider: createProvider(cfg),
        model,
        window,
        signal,
        progress,
        onRetry,
        focus,
        hooks: { conversationId: id, workspace: conv.workspace }
      },
      prior
    )
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

/**
 * The hooks a manual compaction runs, resolved as the loop resolves them for a run
 * (see startRun): the user's own, then a trusted folder's project hooks. A folder
 * whose elevating config drifted from what the user trusted contributes none.
 */
async function compactionHooks(workspace: string): Promise<Hook[]> {
  const settings = getSettings()
  const own = settings.hooks ?? []
  try {
    const config = await loadProjectConfig(workspace)
    const trusted =
      config.elevatedHash !== '' && folderTrustState(settings.trustedFolders, workspace, config.elevatedHash) === 'trusted'
    return trusted ? [...own, ...config.elevated.hooks] : own
  } catch {
    return own
  }
}

/** The chat a compaction hook fires for, as the loop describes a run's (session_id, transcript_path). */
function hookSessionFor(id: string): HookSession {
  try {
    return { id, transcriptPath: conversationFilePath(id), flushTranscript: () => flushConversation(id) }
  } catch {
    return { id }
  }
}

/** Where a compaction's PreCompact and PostCompact hooks run. */
interface CompactHookScope {
  conversationId: string
  workspace: string
}

/** What summarizing a span needs: the provider and model, and how to stop or report. */
interface SpanSummarizer {
  cfg: NonNullable<ReturnType<typeof getProvider>>
  provider: ReturnType<typeof createProvider>
  model: string
  window: number | null | undefined
  signal: AbortSignal
  /** Called as each chunk's summary lands, restarting the per-chunk deadline. */
  progress: () => void
  onRetry: CompactOptions['onRetry']
  focus: string | undefined
  /** The chat whose compaction hooks fire around the summary. */
  hooks: CompactHookScope
}

/**
 * Summarize `messages[from..to)` into the synthetic summary exchange that stands in for
 * it (see buildSummaryMessages). Throws with the reason when it can't.
 *
 * `prior` is the summary pair standing in for `messages[0..from)` when the span
 * continues one (see compactUnderSignal); it is folded into the first chunk, and the
 * result then stands in for everything from message 0.
 *
 * PreCompact and PostCompact hooks fire around it as they do around the loop's own
 * compactions: PreCompact context is folded into the material being summarized, and
 * PostCompact may only add context to the finished summary.
 *
 * The span goes in budget-bounded chunks, each result folded into a running summary.
 * Chunking keeps any single summarization request from itself overflowing the window,
 * essential when the conversation is already over the limit, where a one-shot summary
 * of the whole span would just fail.
 */
async function summarizeSpan(
  messages: ChatMessage[],
  from: number,
  to: number,
  s: SpanSummarizer,
  prior: ChatMessage[] = []
): Promise<ChatMessage[]> {
  const { cfg, provider, model, window, signal, onRetry, focus } = s
  // Each chunk stays well under the window (see summaryChunkBudget), which is what
  // lets `/compact` rescue a conversation that is *already* over the limit.
  const budget = summaryChunkBudget(window)
  // The summaries are written the way the loop's automatic compaction writes them: by
  // the provider's small model when a chunk's request fits its window, with the chat's
  // own model taking over when it doesn't, or when the small model fails.
  const small = smallModelFor(cfg, model)
  const smallWindow = small ? resolveContextWindow(small, cfg.models?.find((m) => m.id === small)?.caps) : null
  const hooks = await compactionHooks(s.hooks.workspace)
  const session = hookSessionFor(s.hooks.conversationId)
  const redact = createSecretRedactor(hooks.length ? collectSecrets() : [])
  const noteHookMessage = (message: string | undefined): void => {
    if (message) log.info(`compact: hook message: ${redact(message)}`)
  }
  const preCompact = await runHooks(
    hooks,
    'PreCompact',
    { tool: 'PreCompact', input: {}, session },
    s.hooks.workspace,
    signal
  )
  noteHookMessage(preCompact.systemMessage)
  if (signal.aborted) throw new Error(COMPACT_ERR_CANCELLED)
  // A PreCompact hook's context rides in front of the span, so the first chunk's
  // summary carries it (adjacent user messages merge in the request).
  let summaryMsgs: ChatMessage[] = preCompact.additionalContext
    ? [...prior, { role: 'user', content: redact(preCompact.additionalContext) }]
    : prior
  const taintFrom = prior.length ? 0 : from
  let summary = ''
  let cut = from
  while (cut < to) {
    const next = findSummaryChunkCut(messages, cut, to, budget)
    const request = buildSummaryRequestMessages(summaryMsgs, messages.slice(cut, next), focus)
    // Each chunk is retried on its own: they fold into a running summary, so losing
    // the whole compaction to a transient blip on the last of them would throw away
    // every chunk before it. Safe to retry in full — the text is accumulated here,
    // not streamed to anyone. A summary cut off at the output cap is an error, not
    // a result: it would replace the head with a summary missing its end.
    const summarizeOn = (summaryModel: string): Promise<string> =>
      withProviderRetry(async () => {
        let acc = ''
        let truncated = false
        for await (const ev of provider.streamChat({
          model: summaryModel,
          system: summarizationSystemPrompt,
          messages: request,
          maxTokens: summaryMaxTokens(summaryModel === model ? window : smallWindow),
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
    const smallFits = small !== null && summaryFits(estimateTokens(summarizationSystemPrompt, request), smallWindow)
    const text = await withSmallModel(smallFits ? small : null, model, summarizeOn, signal)
    if (signal.aborted) throw new Error(COMPACT_ERR_CANCELLED)
    summary = text.trim()
    if (!summary) throw new Error('The model returned an empty summary.')
    // Everything from `from` (or message 0, under a prior summary) up to `next` is now
    // stood in for by this summary, so it carries the taint of all of it.
    summaryMsgs = buildSummaryMessages(summary, headTaint(messages, next, taintFrom))
    cut = next
    s.progress()
  }
  // PostCompact: the summary is written. A hook sees it and may add context to it,
  // nothing more; whatever it says, the compaction stands.
  const postCompact = await runHooks(
    hooks,
    'PostCompact',
    { tool: 'PostCompact', input: {}, summary, session },
    s.hooks.workspace,
    signal
  )
  noteHookMessage(postCompact.systemMessage)
  if (signal.aborted) throw new Error(COMPACT_ERR_CANCELLED)
  if (postCompact.additionalContext) {
    summaryMsgs = buildSummaryMessages(
      `${summary}\n\n${redact(postCompact.additionalContext)}`,
      headTaint(messages, to, taintFrom)
    )
  }
  return summaryMsgs
}

/**
 * Which part of a chat {@link summarizeConversationPart} replaces, around one of the
 * user's messages (its `turn`, numbered as rewind numbers them): `from` replaces that
 * message and everything after it, `before` everything before it.
 */
export interface SummaryPart {
  turn: number
  /** The message as the client showed it, so a log that moved on is refused. */
  text: string
  side: 'from' | 'before'
}

export const SUMMARIZE_ERR_STALE =
  'That message is no longer in this conversation. Reopen the chat and try again.'
const SUMMARIZE_ERR_BUSY = 'A rewind is already in progress for this conversation.'

/**
 * Rewind's "Summarize from here" and "Summarize up to here": replace part of a chat
 * with a summary written by the same summarizer as `/compact` (with its optional
 * focus), leaving files alone. Saved as a rewind, so `/rewind undo` brings the
 * original messages back until the chat moves on.
 */
export function summarizeConversationPart(
  id: string,
  providerId: string,
  model: string,
  part: SummaryPart,
  opts: CompactOptions = {}
): Promise<CompactResult> {
  return underCompactionGuard(id, opts, (signal, progress) =>
    summarizePartUnderSignal(id, providerId, model, part, signal, progress, opts)
  )
}

async function summarizePartUnderSignal(
  id: string,
  providerId: string,
  model: string,
  part: SummaryPart,
  signal: AbortSignal,
  progress: () => void,
  opts: CompactOptions
): Promise<CompactResult> {
  if (activeRunForConversation(id)) {
    return { ok: false, summarized: 0, reason: 'running', error: COMPACT_ERR_RUNNING }
  }
  const stamp = logStamp(id)
  const conv = getConversation(id)
  if (!conv) return { ok: false, summarized: 0, error: 'Conversation not found.' }
  const at = rewindableTurnIndices(conv.messages)[part.turn]
  if (at === undefined || turnText(conv.messages[at]) !== part.text) {
    return { ok: false, summarized: 0, reason: 'changed', error: SUMMARIZE_ERR_STALE }
  }
  const [from, to] = part.side === 'from' ? [at, conv.messages.length] : [0, at]
  if (to <= from) return { ok: true, summarized: 0, reason: 'empty' }

  const cfg = getProvider(providerId)
  if (!cfg) return { ok: false, summarized: 0, error: `Unknown provider: ${providerId}` }
  const window = resolveContextWindow(model, cfg.models?.find((m) => m.id === model)?.caps)
  let summaryMsgs: ChatMessage[]
  try {
    summaryMsgs = await summarizeSpan(conv.messages, from, to, {
      cfg,
      provider: createProvider(cfg),
      model,
      window,
      signal,
      progress,
      onRetry: opts.onRetry,
      focus: opts.focus,
      hooks: { conversationId: id, workspace: conv.workspace }
    })
  } catch (e) {
    return { ok: false, summarized: 0, error: (e as Error).message }
  }
  if (signal.aborted) return { ok: false, summarized: 0, error: COMPACT_ERR_CANCELLED }
  if (activeRunForConversation(id)) {
    return { ok: false, summarized: 0, reason: 'running', error: COMPACT_ERR_RUNNING }
  }
  const busy: CompactResult = { ok: false, summarized: 0, reason: 'busy', error: SUMMARIZE_ERR_BUSY }
  return withRewindLock(id, busy, async () => {
    if (logStamp(id) !== stamp) {
      return { ok: false, summarized: 0, reason: 'changed', error: COMPACT_ERR_CHANGED }
    }
    // Peeked, as a rewind writes: attachments stay as stored references.
    const stored = peekConversation(id)
    if (!stored) return { ok: false, summarized: 0, error: 'Conversation not found.' }
    const before = part.side === 'before'
    const messages = before
      ? [...summaryMsgs, ...stored.messages.slice(at)]
      : [...stored.messages.slice(0, at), ...summaryMsgs]
    const backup: RewindBackup = {
      mode: 'conversation',
      at: Date.now(),
      messages: stored.messages,
      ...(stored.compaction ? { compaction: stored.compaction } : {}),
      ...(stored.lastError ? { lastError: stored.lastError } : {}),
      afterLength: messages.length,
      code: [],
      detached: []
    }
    writeRewind(id, {
      messages,
      // A summary at the head indexes nothing the loop recorded; one at the tail keeps
      // whatever still holds for the messages before it.
      compaction: before ? null : compactionAfterTruncate(stored.compaction, at),
      // A failed turn summarized away leaves nothing to retry.
      lastError: before ? (stored.lastError ?? null) : null,
      backup
    })
    return { ok: true, summarized: to - from, messages: getConversation(id)?.messages ?? messages }
  })
}
