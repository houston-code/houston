/**
 * Token-usage helpers shared by the main process (which reports raw counts from
 * each provider) and the renderer (which displays them). Pure + dependency-free
 * so both processes and the unit tests can use them.
 */
import type { ModelCaps } from './types'
import type { ModelUsage, ConversationUsage } from './agent'
import {
  contextWindowFor,
  modelHasReasoning,
  modelHasVision,
  modelPricing,
  type ModelPricing
} from './model-facts'

// Model-id knowledge lives in model-facts.ts; re-exported here for existing callers.
export { contextWindowFor, modelPricing, type ModelPricing }

/** Per-conversation running token usage (persisted; displayed in the control bar). */
export interface SessionUsage {
  /** Input tokens of the most recent model turn — i.e. the current context size. */
  context: number
  /** Output tokens summed across every model turn run in this conversation. */
  output: number
  /** Estimated cumulative cost in USD across every turn (0 when the model has no known price). */
  cost: number
  /** Cumulative input tokens served from the prompt cache (see ConversationUsage). */
  cacheRead?: number
  /** Per-model cost breakdown, in first-seen order (absent until a turn has billed). */
  perModel?: ModelUsage[]
}

/**
 * Fold one turn's usage into the per-model tallies, keyed by model, in first-seen
 * order. Pure, so the main process (accumulating persisted conversation usage) and
 * the terminal client tally the same way from the same per-round numbers — one
 * definition, no drift between what the GUI and the TUI call "what this cost".
 */
export function accumulateModelUsage(
  tallies: ModelUsage[],
  turn: {
    model?: string
    inputTokens: number
    outputTokens: number
    cost: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
  }
): ModelUsage[] {
  // An older event carries no model. It still counts toward the session, so label
  // the row for what it honestly is rather than inventing a model name.
  const model = turn.model ?? 'session'
  const out = tallies.some((t) => t.model === model)
    ? tallies.map((t) => ({ ...t }))
    : [...tallies.map((t) => ({ ...t })), blankModelUsage(model)]
  const t = out.find((x) => x.model === model) as ModelUsage
  t.inputTokens += turn.inputTokens
  t.outputTokens += turn.outputTokens
  t.cost += turn.cost
  t.cacheReadTokens += turn.cacheReadTokens ?? 0
  t.cacheWriteTokens += turn.cacheWriteTokens ?? 0
  return out
}

function blankModelUsage(model: string): ModelUsage {
  return { model, inputTokens: 0, outputTokens: 0, cost: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
}

/**
 * Map a conversation's persisted usage to the shape the control bar renders. One
 * place so a field added to {@link ConversationUsage} can't be silently dropped on
 * reopen — the reason the per-model breakdown and cache split used to vanish when a
 * conversation was reopened (only `context`/`output`/`cost` were carried across).
 */
export function sessionUsageFromConversation(u: ConversationUsage): SessionUsage {
  return {
    context: u.inputTokens,
    output: u.outputTokens,
    cost: u.cost ?? 0,
    cacheRead: u.cacheReadTokens,
    perModel: u.perModel
  }
}

/**
 * Resolve a model's pricing, preferring host-listed prices (`caps`, from the model
 * listing) over the name-heuristics — per-field, mirroring how
 * {@link resolveCapabilities} treats capability flags. Host prices are exact where
 * the heuristics approximate, and the only pricing at all for host-routed ids the
 * heuristics don't know (deepseek, qwen, …). Returns null only when neither side
 * can supply an input+output rate.
 */
export function resolvePricing(model: string, caps?: ModelCaps): ModelPricing | null {
  const h = modelPricing(model)
  const input = caps?.inputPrice ?? h?.input
  const output = caps?.outputPrice ?? h?.output
  if (input === undefined || output === undefined) return null
  const cacheRead = caps?.cacheReadPrice ?? h?.cacheRead
  const cacheWrite = caps?.cacheWritePrice ?? h?.cacheWrite
  return {
    input,
    output,
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {})
  }
}

/**
 * Fallback prompt-cache price multipliers, relative to a model's base input rate:
 * a cached prefix that is *read* bills at 10% of the input price, and *writing* a
 * (5-minute) cache entry bills at 125%. These are Anthropic's published
 * multipliers and apply when a family has no explicit `cacheRead`/`cacheWrite`
 * price (the Claude families); OpenAI and Gemini rates differ per family, so
 * those carry explicit prices in {@link modelPricing} instead.
 */
export const CACHE_READ_PRICE_MULTIPLIER = 0.1
export const CACHE_WRITE_PRICE_MULTIPLIER = 1.25

/** The prompt-cache split of a turn's input tokens, for caching-aware cost. */
export interface CacheTokens {
  /** Tokens served from cache (a subset of inputTokens), billed below the input rate. */
  readTokens?: number
  /** Tokens that wrote a new cache entry (a subset of inputTokens); free on some families, a surcharge on others. */
  writeTokens?: number
}

/**
 * Estimated USD cost of one turn's tokens for `model` (0 when the price is unknown).
 *
 * `inputTokens` is the FULL input prefix — fresh tokens plus any served from or
 * written to the prompt cache. When a `cache` split is given, the cached portions
 * are priced at the family's cache rates (explicit `cacheRead`/`cacheWrite` prices
 * when known, the Anthropic multipliers otherwise) and only the remaining fresh
 * tokens pay the full input rate; without it, every input token pays full rate (the
 * historical behavior). This matters a lot for agent loops, where a warm cache means
 * most of each turn's input is a cheap cache read, not full-price fresh input.
 *
 * `caps` carries host-listed per-model prices when available (see
 * {@link resolvePricing}); without it, the name-heuristic rates apply.
 */
export function turnCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cache?: CacheTokens,
  caps?: ModelCaps
): number {
  const p = resolvePricing(model, caps)
  if (!p) return 0
  const inTok = clampTokens(inputTokens)
  const outTok = clampTokens(outputTokens)
  const cacheRead = Math.min(inTok, clampTokens(cache?.readTokens))
  const cacheWrite = Math.min(inTok - cacheRead, clampTokens(cache?.writeTokens))
  // The fresh, full-price portion is whatever wasn't a cache read/write. The min()
  // guards above keep the parts from exceeding the whole if a provider's counts drift.
  const freshInput = inTok - cacheRead - cacheWrite
  // Family-specific cache prices when known; the Anthropic multipliers otherwise.
  // `??` (not `||`) so an explicit 0 — free cache writes — is honored.
  const cacheReadPrice = p.cacheRead ?? p.input * CACHE_READ_PRICE_MULTIPLIER
  const cacheWritePrice = p.cacheWrite ?? p.input * CACHE_WRITE_PRICE_MULTIPLIER
  const inputCost = freshInput * p.input + cacheRead * cacheReadPrice + cacheWrite * cacheWritePrice
  return inputCost / 1_000_000 + (outTok / 1_000_000) * p.output
}

/** Non-negative finite token count, else 0. */
function clampTokens(v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

/** Format a USD amount with precision that scales to the magnitude: `$0.0042`, `$0.071`, `$1.23`. */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0.00'
  if (n < 0.01) return `$${n.toFixed(4)}`
  if (n < 1) return `$${n.toFixed(3)}`
  return `$${n.toFixed(2)}`
}

/** What a model can do beyond plain text, matched by family. */
export interface ModelCapabilities {
  /** Accepts image inputs (multimodal vision). */
  vision: boolean
  /** Has an extended-thinking / reasoning mode. */
  reasoning: boolean
}

/**
 * Best-effort capability flags for a model id, matched by family. Conservative:
 * unknown / local models report no capabilities (all false), so callers gate
 * rather than over-promise. Approximate — provider line-ups change over time.
 *
 * The rules live in model-facts.ts; reasoning is the union of the same per-provider
 * gates the request builders use, so the UI and the API agree on which models
 * actually accept a thinking/reasoning parameter.
 */
export function modelCapabilities(model: string): ModelCapabilities {
  return { vision: modelHasVision(model), reasoning: modelHasReasoning(model) }
}

/**
 * Resolve a model's capabilities, preferring host-provided metadata (`caps`, from
 * the model listing) over the name-heuristics. Each field falls back independently,
 * so a host that reports only context_length still gets heuristic vision/reasoning.
 * This is how host-routed ids the heuristics don't recognize (deepseek-r1, gemma-3)
 * still surface the right flags.
 */
export function resolveCapabilities(model: string, caps?: ModelCaps): ModelCapabilities {
  const h = modelCapabilities(model)
  return {
    vision: caps?.vision ?? h.vision,
    reasoning: caps?.reasoning ?? h.reasoning
  }
}

/**
 * Resolved tool-calling support: the host's listed value when known, else null
 * ("unknown" — the caller may probe a local server or simply stay silent). There's
 * no name-heuristic fallback because most tool-capable open models can't be told
 * apart from incapable ones by id alone.
 */
export function resolveToolSupport(caps?: ModelCaps): boolean | null {
  return caps?.tools ?? null
}

/** Context window, preferring host-provided metadata over the family heuristic. */
export function resolveContextWindow(model: string, caps?: ModelCaps): number | null {
  return caps?.contextWindow ?? contextWindowFor(model)
}

/**
 * Context fill as a whole-number percentage of the window, clamped to [0, 100].
 * Returns null when the window is unknown or there's nothing to show.
 */
export function contextPercent(context: number, window: number | null): number | null {
  if (!window || window <= 0 || !Number.isFinite(context) || context <= 0) return null
  return Math.min(100, Math.round((context / window) * 100))
}

/**
 * Format a token count compactly: `812`, `12.3k`, `1.2M`. Trailing `.0` is
 * dropped (`5k`, not `5.0k`). Negative or non-finite inputs clamp to `0`.
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${trim(n / 1000)}k`
  return `${trim(n / 1_000_000)}M`
}

function trim(v: number): string {
  const s = v.toFixed(1)
  return s.endsWith('.0') ? s.slice(0, -2) : s
}
