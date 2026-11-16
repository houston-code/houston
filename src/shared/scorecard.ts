/**
 * Per-model "loop scorecard" — a LOCAL-ONLY aggregation over the persisted
 * conversations, computed on-device and never transmitted anywhere. Pure and
 * dependency-free (like {@link ./usage}) so both processes and the unit tests can
 * use it, and so the main process can fold a directory of conversation JSON files
 * into it without pulling in any renderer code.
 *
 * Strict privacy: this module reads only the fields it is handed (model id, usage
 * totals, and the shape and metadata of the message log: roles, tool names, each
 * reply's model, promptId and usage, and each run's saved stop record). It never
 * inspects message *content*. The failure signals shown beside it come from
 * {@link ./failureSignals}, which does read text and tool results (still counts only,
 * still on-device); keeping the two apart keeps this guarantee checkable here.
 *
 * WHAT IS PERSISTED. Each saved reply names the model that served it and the
 * `promptId` of Houston's instructions that produced it (`ChatMessage.model`,
 * `ChatMessage.promptId`), along with what its round billed. A run that ended other
 * than by finishing (it failed, was stopped, or hit a limit) leaves a record of why on
 * its last message (`ChatMessage.runEnds`, read through {@link runEndRecords}). So a
 * reply's step, cost and tool calls count toward the model that actually wrote it, and
 * the run-end counts are exact. What is still reconstructed: a "step" is one assistant
 * turn, a tool call is one `tool` turn, and "clean finish" is inferred from how the log
 * ends (see {@link deriveOutcome}). Older chats predate some of these fields and fall
 * back to the chat's own model and running totals.
 */
import type { ChatMessage, RunLimitReason } from './agent'
import type { FailureSignalCounts } from './failureSignals'
import { runEndRecords } from './runEnd'
import { turnCostUsd } from './usage'

/**
 * The minimal per-conversation shape the scorecard needs. A structural subset of
 * {@link Conversation} so the main-process scan can pass conversations straight in,
 * and the tests can fabricate fixtures without building a whole Conversation.
 */
export interface ScorecardConversationInput {
  /** Model id the conversation runs on (e.g. `claude-opus-4-6`): the row for anything no reply names. */
  model: string
  /** The full message log — scanned for step/tool counts and outcome inference. */
  messages: ChatMessage[]
  /**
   * How many messages at the start of `messages` were copied from another chat (a
   * fork, or a session spawned with a forked context). They're that chat's work, so
   * only what follows counts here. Default 0.
   */
  inherited?: number
  /** Persisted cumulative usage, when present. `inputTokens` is the LATEST turn's
   *  context size (NOT a running sum); only `outputTokens` and `cost` accumulate. */
  usage?: { inputTokens: number; outputTokens: number; cost: number }
  /** True when the conversation's most recent run ended in an error (mirrors
   *  {@link ConversationMeta.errored}). Used for the failure/error rate. */
  errored?: boolean
}

/** How a conversation's most recent run appears to have ended, inferred from its
 *  message log, its saved run-end records and the errored flag. */
export type RunOutcome =
  /** Ended with a plain assistant turn that ran no tools — the natural "clean stop". */
  | 'completed'
  /** The most recent run ended in a persisted error. */
  | 'error'
  /** Didn't finish: stopped, hit a limit, or can't tell (empty log, or still mid-flight). */
  | 'incomplete'

/**
 * What the rows are: one per model, or one per model and prompt version (the
 * `promptId` each reply carries), to compare a model's behavior before and after a
 * change to Houston's own instructions.
 */
export type ScorecardGroupBy = 'model' | 'model-prompt'

/** Which row something is counted in. `promptId` only when grouped by prompt version. */
export interface ScorecardGroupKey {
  model: string
  /** Absent for replies saved before Houston recorded one, and in the model-only grouping. */
  promptId?: string
}

/** How many runs ended other than by finishing, by why (see {@link ChatMessage.runEnds}). */
export interface RunEndCounts {
  /** Runs that failed. */
  error: number
  /** Runs the user stopped. */
  aborted: number
  /** Runs that hit each limit. */
  limits: Record<RunLimitReason, number>
}

/** A single tool's slice of the tool-usage histogram, for one model. */
export interface ToolUsageEntry {
  /** The tool name (e.g. `read_file`, `run_shell`). */
  name: string
  /** How many times this tool was invoked across the model's conversations. */
  count: number
}

/** Aggregated metrics for one row: a model (or a model and prompt version). */
export interface ModelScorecard {
  model: string
  /** Set when grouped by prompt version; absent for replies saved before Houston recorded one. */
  promptId?: string
  /** Number of conversations ("runs") with anything counted in this row. */
  runs: number
  /** Total model "steps" (assistant turns this model wrote) across all runs. */
  totalSteps: number
  /** Mean assistant turns per run (`totalSteps / runs`), 0 when there are no runs. */
  avgSteps: number
  /** Total executed tool calls (`tool` turns answering this model's calls) across all runs. */
  totalToolCalls: number
  /** Mean tool calls per run, 0 when there are no runs. */
  avgToolCalls: number
  /** Cumulative output tokens across all runs (input tokens are per-turn context
   *  sizes, not cumulative, so they are intentionally NOT summed here). */
  totalOutputTokens: number
  /** Cumulative estimated USD cost across all runs. */
  totalCost: number
  /** Mean estimated USD cost per run, 0 when there are no runs. */
  avgCost: number
  /** How many conversations whose latest run is counted here ended it cleanly (outcome `completed`). */
  completedRuns: number
  /** How many conversations whose latest run is counted here ended it otherwise (error or incomplete). */
  limitedRuns: number
  /** `completedRuns / (completedRuns + limitedRuns)`, in [0, 1]; 0 when neither. */
  completionRate: number
  /** Every run that ended other than by finishing, by why, from the records runs leave. */
  runEnds: RunEndCounts
  /** Tool-usage histogram, most-used first (ties broken by name for stable order). */
  tools: ToolUsageEntry[]
  /**
   * The failure signals counted in this row, when the scan that built the scorecard
   * attached them (see `attachFailureSignals` in ./failureSignals). Never set here.
   */
  signals?: FailureSignalCounts
}

/** The whole scorecard: one row per model plus a totals summary. All local. */
export interface Scorecard {
  /** What each row is. */
  groupBy: ScorecardGroupBy
  /** Rows, ordered by total cost desc then run count desc then model asc (then prompt id). */
  models: ModelScorecard[]
  /** Number of conversations that fed the scorecard. */
  totalRuns: number
  /** Summed estimated USD cost across every model. */
  totalCost: number
}

/** A row's identity as one string, for maps and React keys. */
export function groupKeyId(k: ScorecardGroupKey): string {
  return k.promptId === undefined ? k.model : `${k.model}\u0000${k.promptId}`
}

/**
 * The row each message of a log is counted in. A reply counts in its own row: the
 * model that served it (the chat's model when an older reply doesn't say) and, grouped
 * by prompt version, its `promptId`. Every other message counts in the row of the
 * latest reply before it, so a tool result counts where its call was made and a
 * run-end record where that run's last reply was. A message before any reply counts
 * in the chat's own model's row. A run that failed before replying is therefore
 * credited to the model of the reply before it, which is right unless the model was
 * switched just before that run (the record doesn't name one).
 */
export function messageGroups(
  messages: readonly ChatMessage[],
  chatModel: string,
  groupBy: ScorecardGroupBy = 'model'
): ScorecardGroupKey[] {
  const fallback: ScorecardGroupKey = { model: chatModel || 'unknown' }
  let current = fallback
  return messages.map((m) => {
    if (m.role === 'assistant') {
      const model = m.model || fallback.model
      current = groupBy === 'model-prompt' && m.promptId ? { model, promptId: m.promptId } : { model }
    }
    return current
  })
}

export function emptyRunEndCounts(): RunEndCounts {
  return { error: 0, aborted: 0, limits: { 'max-steps': 0, 'max-output': 0, stalled: 0, 'max-cost': 0 } }
}

/**
 * A row's run-end counts as short labeled parts, most common kinds first in a fixed
 * order, leaving out the kinds that never happened. Shared by the desktop panel and
 * `/scorecard` so the two word them the same.
 */
export function runEndParts(c: RunEndCounts): Array<{ label: string; count: number }> {
  const parts = [
    { label: 'failed', count: c.error },
    { label: 'stopped', count: c.aborted },
    { label: 'step limit', count: c.limits['max-steps'] },
    { label: 'output limit', count: c.limits['max-output'] },
    { label: 'stalled', count: c.limits.stalled },
    { label: 'cost limit', count: c.limits['max-cost'] }
  ]
  return parts.filter((p) => p.count > 0)
}

/**
 * Infer how a conversation's most recent run ended, walking back from the end of
 * the log:
 *  - `errored` set → `error` (a run that failed is not a clean completion).
 *  - a message carrying a run-end record → that record decides: `error` for a
 *    failure, `incomplete` for a stop or a limit (the step cap leaves a plain text
 *    reply, so without the record it would read as a clean finish).
 *  - otherwise the log ends on an assistant turn that called NO tools → `completed`
 *    (the model chose to stop talking — the loop's natural end-of-run branch).
 *  - the log ends on a tool call or a tool result (or is empty) → `incomplete`:
 *    the run was cut off mid-flight (or is still running).
 * A trailing user turn without a record (a message queued after the run ended) is
 * skipped. Pure; exported so it can be unit-tested against fabricated logs directly.
 */
export function deriveOutcome(input: ScorecardConversationInput): RunOutcome {
  if (input.errored) return 'error'
  const msgs = input.messages
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    const end = runEndRecords(m).at(-1)
    if (end) return end.reason === 'error' ? 'error' : 'incomplete'
    if (m.role === 'assistant') {
      return m.toolCalls && m.toolCalls.length > 0 ? 'incomplete' : 'completed'
    }
    if (m.role === 'tool') return 'incomplete'
  }
  return 'incomplete'
}

/** Round to at most `places` decimals without trailing-zero noise (returns a number). */
function round(n: number, places = 2): number {
  if (!Number.isFinite(n)) return 0
  const f = 10 ** places
  return Math.round(n * f) / f
}

const nonNeg = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

/**
 * A conversation's cumulative cost, preferring the persisted `usage.cost` (what the
 * meter actually charged) and falling back to a fresh estimate from the token counts
 * when a conversation never recorded a cost (e.g. older data, or a turn whose price
 * was unknown at the time but is known now). Never negative.
 */
function conversationCost(input: ScorecardConversationInput): number {
  const u = input.usage
  if (!u) return 0
  if (u.cost > 0) return u.cost
  // Nothing was ever answered here (a fork that hasn't run yet carries only its
  // context size): there is no spend to estimate.
  if (u.outputTokens <= 0) return 0
  // No recorded cost — recompute from tokens with today's price table. inputTokens
  // is only the latest turn's context, but it's the best available proxy when no
  // cost was persisted; outputTokens is the true cumulative output.
  const est = turnCostUsd(input.model, u.inputTokens, u.outputTokens)
  return est > 0 ? est : 0
}

/**
 * Aggregate a set of conversations into a per-model (or per model and prompt
 * version) scorecard. Pure: same input → same output, no I/O, no clock, no globals.
 * The caller (main process) is responsible for reading the local conversation files
 * and handing them in; nothing here touches the network or the filesystem.
 *
 * Each reply's step and billed usage, and the tool calls that answer it, count in
 * its own row ({@link messageGroups}). Whatever the chat's running totals hold
 * beyond its replies (subagents, reviews, chats saved before replies recorded their
 * usage) counts in the row of the chat's last message, as does how its latest run
 * ended.
 *
 * Conversations with an empty message log AND no usage are skipped — they're
 * brand-new "New chat" placeholders that never ran, and counting them as runs
 * would dilute every average with zeros.
 */
export function buildScorecard(
  conversations: ScorecardConversationInput[],
  options: { groupBy?: ScorecardGroupBy } = {}
): Scorecard {
  const groupBy = options.groupBy ?? 'model'
  // Per-row running accumulators, keyed by groupKeyId.
  interface Acc {
    key: ScorecardGroupKey
    runs: number
    steps: number
    toolCalls: number
    outputTokens: number
    cost: number
    completed: number
    limited: number
    ends: RunEndCounts
    tools: Map<string, number>
  }
  const rows = new Map<string, Acc>()

  const accFor = (key: ScorecardGroupKey): Acc => {
    const id = groupKeyId(key)
    let a = rows.get(id)
    if (!a) {
      a = {
        key,
        runs: 0,
        steps: 0,
        toolCalls: 0,
        outputTokens: 0,
        cost: 0,
        completed: 0,
        limited: 0,
        ends: emptyRunEndCounts(),
        tools: new Map()
      }
      rows.set(id, a)
    }
    return a
  }

  let totalRuns = 0
  for (const input of conversations) {
    // Only this chat's own messages: a copied history is counted with its source.
    const start = Math.max(0, input.inherited ?? 0)
    const own = start ? input.messages.slice(start) : input.messages
    const conv: ScorecardConversationInput = { ...input, messages: own }
    const hasUsage = !!conv.usage && (conv.usage.outputTokens > 0 || conv.usage.cost > 0)
    if (own.length === 0 && !hasUsage) continue // never-ran placeholder (or an unused fork)
    totalRuns++
    // Over the whole log, so a tool result right after the copied history still finds its reply.
    const keys = messageGroups(input.messages, input.model, groupBy)
    const touched = new Set<Acc>()
    let replyCost = 0
    let replyOutput = 0
    for (let i = start; i < input.messages.length; i++) {
      const m = input.messages[i]
      const a = accFor(keys[i])
      if (m.role === 'assistant') {
        a.steps++
        touched.add(a)
        if (m.usage) {
          const cost = nonNeg(m.usage.cost)
          const out = nonNeg(m.usage.outputTokens)
          a.cost += cost
          a.outputTokens += out
          replyCost += cost
          replyOutput += out
        }
      } else if (m.role === 'tool') {
        // A `tool` turn is one executed call: the ground truth for "what ran" (a reply
        // may request calls an aborted run never resolved). Unnamed ones are bucketed
        // under `unknown` rather than dropped, so the totals stay honest.
        a.toolCalls++
        const name = m.toolName || 'unknown'
        a.tools.set(name, (a.tools.get(name) ?? 0) + 1)
        touched.add(a)
      }
      for (const r of runEndRecords(m)) {
        if (r.reason === 'limit') a.ends.limits[r.limit ?? 'max-steps']++
        else a.ends[r.reason]++
        touched.add(a)
      }
    }
    // The chat's running totals beyond what its replies recorded, and how its latest
    // run ended, go to the row of its last message.
    const home = accFor(keys.at(-1) ?? { model: input.model || 'unknown' })
    touched.add(home)
    const output = Math.max(0, nonNeg(conv.usage?.outputTokens) - replyOutput)
    home.outputTokens += output
    home.cost += Math.max(0, conversationCost(conv) - replyCost)
    if (deriveOutcome(conv) === 'completed') home.completed++
    else home.limited++
    for (const a of touched) a.runs++
  }

  const models: ModelScorecard[] = []
  for (const a of rows.values()) {
    if (a.runs === 0) continue
    const tools: ToolUsageEntry[] = [...a.tools.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((x, y) => y.count - x.count || x.name.localeCompare(y.name))
    const ended = a.completed + a.limited
    models.push({
      model: a.key.model,
      ...(a.key.promptId !== undefined ? { promptId: a.key.promptId } : {}),
      runs: a.runs,
      totalSteps: a.steps,
      avgSteps: round(a.steps / a.runs, 1),
      totalToolCalls: a.toolCalls,
      avgToolCalls: round(a.toolCalls / a.runs, 1),
      totalOutputTokens: a.outputTokens,
      totalCost: round(a.cost, 4),
      avgCost: round(a.cost / a.runs, 4),
      completedRuns: a.completed,
      limitedRuns: a.limited,
      completionRate: ended ? round(a.completed / ended, 4) : 0,
      runEnds: a.ends,
      tools
    })
  }

  // Costliest models first — that's what a "where is my budget going" glance wants.
  // Ties fall back to run count, then model id (then prompt id) for a stable order.
  models.sort(
    (x, y) =>
      y.totalCost - x.totalCost ||
      y.runs - x.runs ||
      x.model.localeCompare(y.model) ||
      (x.promptId ?? '').localeCompare(y.promptId ?? '')
  )

  const totalCost = round(
    models.reduce((s, m) => s + m.totalCost, 0),
    4
  )
  return { groupBy, models, totalRuns, totalCost }
}
