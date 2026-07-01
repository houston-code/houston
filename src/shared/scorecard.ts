/**
 * Per-model "loop scorecard" — a LOCAL-ONLY aggregation over the persisted
 * conversations, computed on-device and never transmitted anywhere. Pure and
 * dependency-free (like {@link ./usage}) so both processes and the unit tests can
 * use it, and so the main process can fold a directory of conversation JSON files
 * into it without pulling in any renderer code.
 *
 * Strict privacy: this module reads only the fields it is handed (model id, usage
 * totals, and the shape of the message log — role/toolCalls/toolName counts). It
 * never inspects message *content*, so aggregating for display can't leak what the
 * user actually said. The caller (main process) scans local files only.
 *
 * WHAT IS AND ISN'T PERSISTED. Houston does not persist a per-run stop reason
 * (end_turn / max_tokens / aborted) or a per-turn tool-call tally — only the
 * message log, the cumulative usage totals, and a boolean "the last run errored"
 * flag survive to disk. So every derived metric below is reconstructed by scanning
 * `messages`: an assistant turn is one model "step"; a `tool` turn is one executed
 * tool call (grouped by `toolName` for the histogram). "Completion vs limit" is
 * inferred, not recorded — see {@link deriveOutcome}. These are honest
 * approximations of loop behavior, labeled as such in the UI, not exact telemetry.
 */
import type { ChatMessage } from './agent'
import { turnCostUsd } from './usage'

/**
 * The minimal per-conversation shape the scorecard needs. A structural subset of
 * {@link Conversation} so the main-process scan can pass conversations straight in,
 * and the tests can fabricate fixtures without building a whole Conversation.
 */
export interface ScorecardConversationInput {
  /** Model id the conversation ran on (e.g. `claude-opus-4-6`). Groups the rows. */
  model: string
  /** The full message log — scanned for step/tool counts and outcome inference. */
  messages: ChatMessage[]
  /** Persisted cumulative usage, when present. `inputTokens` is the LATEST turn's
   *  context size (NOT a running sum); only `outputTokens` and `cost` accumulate. */
  usage?: { inputTokens: number; outputTokens: number; cost: number }
  /** True when the conversation's most recent run ended in an error (mirrors
   *  {@link ConversationMeta.errored}). Used for the failure/error rate. */
  errored?: boolean
}

/** How a conversation's most recent run appears to have ended, inferred from its
 *  message log + errored flag (no stop reason is persisted — see module note). */
export type RunOutcome =
  /** Ended with a plain assistant turn that ran no tools — the natural "clean stop". */
  | 'completed'
  /** The most recent run ended in a persisted error. */
  | 'error'
  /** Can't tell (empty log, or ends mid-tool-call — e.g. aborted or still mid-flight). */
  | 'incomplete'

/** A single tool's slice of the tool-usage histogram, for one model. */
export interface ToolUsageEntry {
  /** The tool name (e.g. `read_file`, `run_shell`). */
  name: string
  /** How many times this tool was invoked across the model's conversations. */
  count: number
}

/** Aggregated metrics for one model across every conversation that ran on it. */
export interface ModelScorecard {
  model: string
  /** Number of conversations ("runs") aggregated into this row. */
  runs: number
  /** Total model "steps" (assistant turns) across all runs. */
  totalSteps: number
  /** Mean assistant turns per run (`totalSteps / runs`), 0 when there are no runs. */
  avgSteps: number
  /** Total executed tool calls (`tool` turns) across all runs. */
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
  /** How many runs ended cleanly (outcome `completed`). */
  completedRuns: number
  /** How many runs ended in an inferred limit / non-clean stop (error or incomplete). */
  limitedRuns: number
  /** Fraction of runs that ended cleanly, in [0, 1]; 0 when there are no runs. */
  completionRate: number
  /** Tool-usage histogram, most-used first (ties broken by name for stable order). */
  tools: ToolUsageEntry[]
}

/** The whole scorecard: one row per model plus a totals summary. All local. */
export interface Scorecard {
  /** Per-model rows, ordered by total cost desc then run count desc then model asc. */
  models: ModelScorecard[]
  /** Number of conversations that fed the scorecard. */
  totalRuns: number
  /** Summed estimated USD cost across every model. */
  totalCost: number
}

/**
 * Infer how a conversation's most recent run ended. Because no stop reason is
 * persisted, we reason from the tail of the message log plus the errored flag:
 *  - `errored` set → `error` (a run that failed is not a clean completion).
 *  - the log ends on an assistant turn that called NO tools → `completed` (the
 *    model chose to stop talking — the loop's natural end-of-run branch).
 *  - the log ends on a tool call or a tool result (or is empty) → `incomplete`:
 *    the run was cut off mid-flight (aborted, hit a step/output limit, or is still
 *    running), none of which is a clean completion.
 * Pure; exported so it can be unit-tested against fabricated logs directly.
 */
export function deriveOutcome(input: ScorecardConversationInput): RunOutcome {
  if (input.errored) return 'error'
  const msgs = input.messages
  if (msgs.length === 0) return 'incomplete'
  // Walk back to the last assistant or tool turn (skip any trailing user turn —
  // e.g. a queued message typed after the run ended shouldn't mask the outcome).
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.role === 'assistant') {
      return m.toolCalls && m.toolCalls.length > 0 ? 'incomplete' : 'completed'
    }
    if (m.role === 'tool') return 'incomplete'
  }
  return 'incomplete'
}

/** Count the assistant turns ("steps") in a message log. */
function countSteps(messages: ChatMessage[]): number {
  let n = 0
  for (const m of messages) if (m.role === 'assistant') n++
  return n
}

/**
 * Tally executed tool calls by name from a message log. A `tool` turn is one
 * executed call and carries the `toolName` that produced it; that's the ground
 * truth for "what ran" (an assistant turn may *request* tools that never resolve
 * on an aborted run, so we count results, not requests). Unnamed tool turns are
 * bucketed under `unknown` rather than dropped, so the totals stay honest.
 */
function tallyTools(messages: ChatMessage[], into: Map<string, number>): void {
  for (const m of messages) {
    if (m.role !== 'tool') continue
    const name = m.toolName || 'unknown'
    into.set(name, (into.get(name) ?? 0) + 1)
  }
}

/** Round to at most `places` decimals without trailing-zero noise (returns a number). */
function round(n: number, places = 2): number {
  if (!Number.isFinite(n)) return 0
  const f = 10 ** places
  return Math.round(n * f) / f
}

/**
 * A model's cumulative cost, preferring the persisted `usage.cost` (what the meter
 * actually charged) and falling back to a fresh estimate from the token counts
 * when a conversation never recorded a cost (e.g. older data, or a turn whose price
 * was unknown at the time but is known now). Never negative.
 */
function conversationCost(input: ScorecardConversationInput): number {
  const u = input.usage
  if (!u) return 0
  if (u.cost > 0) return u.cost
  // No recorded cost — recompute from tokens with today's price table. inputTokens
  // is only the latest turn's context, but it's the best available proxy when no
  // cost was persisted; outputTokens is the true cumulative output.
  const est = turnCostUsd(input.model, u.inputTokens, u.outputTokens)
  return est > 0 ? est : 0
}

/**
 * Aggregate a set of conversations into a per-model scorecard. Pure: same input →
 * same output, no I/O, no clock, no globals. The caller (main process) is
 * responsible for reading the local conversation files and handing them in;
 * nothing here touches the network or the filesystem.
 *
 * Conversations with an empty message log AND no usage are skipped — they're
 * brand-new "New chat" placeholders that never ran, and counting them as runs
 * would dilute every average with zeros.
 */
export function buildScorecard(conversations: ScorecardConversationInput[]): Scorecard {
  // Per-model running accumulators, keyed by model id.
  interface Acc {
    runs: number
    steps: number
    toolCalls: number
    outputTokens: number
    cost: number
    completed: number
    limited: number
    tools: Map<string, number>
  }
  const byModel = new Map<string, Acc>()

  const accFor = (model: string): Acc => {
    let a = byModel.get(model)
    if (!a) {
      a = {
        runs: 0,
        steps: 0,
        toolCalls: 0,
        outputTokens: 0,
        cost: 0,
        completed: 0,
        limited: 0,
        tools: new Map()
      }
      byModel.set(model, a)
    }
    return a
  }

  for (const conv of conversations) {
    const hasUsage = !!conv.usage && (conv.usage.outputTokens > 0 || conv.usage.cost > 0)
    if (conv.messages.length === 0 && !hasUsage) continue // never-ran placeholder
    const model = conv.model || 'unknown'
    const a = accFor(model)
    a.runs++
    a.steps += countSteps(conv.messages)
    let toolTurns = 0
    for (const m of conv.messages) if (m.role === 'tool') toolTurns++
    a.toolCalls += toolTurns
    tallyTools(conv.messages, a.tools)
    if (conv.usage) {
      a.outputTokens += conv.usage.outputTokens > 0 ? conv.usage.outputTokens : 0
    }
    a.cost += conversationCost(conv)
    if (deriveOutcome(conv) === 'completed') a.completed++
    else a.limited++
  }

  const models: ModelScorecard[] = []
  for (const [model, a] of byModel) {
    const tools: ToolUsageEntry[] = [...a.tools.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((x, y) => y.count - x.count || x.name.localeCompare(y.name))
    models.push({
      model,
      runs: a.runs,
      totalSteps: a.steps,
      avgSteps: a.runs ? round(a.steps / a.runs, 1) : 0,
      totalToolCalls: a.toolCalls,
      avgToolCalls: a.runs ? round(a.toolCalls / a.runs, 1) : 0,
      totalOutputTokens: a.outputTokens,
      totalCost: round(a.cost, 4),
      avgCost: a.runs ? round(a.cost / a.runs, 4) : 0,
      completedRuns: a.completed,
      limitedRuns: a.limited,
      completionRate: a.runs ? round(a.completed / a.runs, 4) : 0,
      tools
    })
  }

  // Costliest models first — that's what a "where is my budget going" glance wants.
  // Ties fall back to run count, then model id for a stable, deterministic order.
  models.sort(
    (x, y) => y.totalCost - x.totalCost || y.runs - x.runs || x.model.localeCompare(y.model)
  )

  const totalRuns = models.reduce((s, m) => s + m.runs, 0)
  const totalCost = round(
    models.reduce((s, m) => s + m.totalCost, 0),
    4
  )
  return { models, totalRuns, totalCost }
}
