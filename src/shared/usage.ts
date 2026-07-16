/**
 * Token-usage helpers shared by the main process (which reports raw counts from
 * each provider) and the renderer (which displays them). Pure + dependency-free
 * so both processes and the unit tests can use them.
 */
import type { ModelCaps } from './types'

/** Per-conversation running token usage (persisted; displayed in the control bar). */
export interface SessionUsage {
  /** Input tokens of the most recent model turn — i.e. the current context size. */
  context: number
  /** Output tokens summed across every model turn run in this conversation. */
  output: number
  /** Estimated cumulative cost in USD across every turn (0 when the model has no known price). */
  cost: number
}

/** Per-million-token prices in USD for a model (input vs output tokens). */
export interface ModelPricing {
  input: number
  output: number
  /**
   * Price per 1M cached-input tokens read back from the prompt cache. Cache-read
   * discounts vary by family (Anthropic 0.1x, GPT-4o 0.5x, GPT-4.1/o-series 0.25x,
   * GPT-5 0.1x, Gemini 0.25x), so it's a price, not a shared multiplier. Absent ⇒
   * fall back to `input * CACHE_READ_PRICE_MULTIPLIER` (the Anthropic rate).
   */
  cacheRead?: number
  /**
   * Price per 1M tokens that wrote a new cache entry. `0` means writes are free
   * (OpenAI, Gemini implicit caching) — distinct from absent, which falls back to
   * `input * CACHE_WRITE_PRICE_MULTIPLIER` (Anthropic's 1.25x surcharge).
   */
  cacheWrite?: number
}

/**
 * Best-effort USD price per 1M tokens for a model id, matched by family. Returns
 * null for unknown / local models (Ollama, LM Studio), in which case no cost is
 * shown. Approximate — provider prices change over time; this is a rough guide,
 * not a billing source of truth.
 */
export function modelPricing(model: string): ModelPricing | null {
  const m = model.toLowerCase()
  // Anthropic (Claude) — current per-MTok rates. Fable / Mythos are the flagship
  // tier and priced above Opus; check them before the opus/sonnet/haiku families.
  if (m.includes('fable') || m.includes('mythos')) return { input: 10, output: 50 }
  if (m.includes('opus')) return { input: 5, output: 25 }
  if (m.includes('sonnet')) return { input: 3, output: 15 }
  if (m.includes('haiku')) return { input: 1, output: 5 }
  // OpenAI (GPT / o-series). Cache reads bill at a per-family discount (0.5x on
  // GPT-4o, 0.25x on GPT-4.1/o-series, 0.1x on GPT-5.x); cache writes are free
  // (cacheWrite: 0), unlike Anthropic's 1.25x write surcharge.
  if (m.includes('gpt-4o-mini')) return { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0 }
  if (m.includes('gpt-4o')) return { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 }
  if (m.includes('gpt-4.1-mini')) return { input: 0.4, output: 1.6, cacheRead: 0.1, cacheWrite: 0 }
  if (m.includes('gpt-4.1')) return { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 }
  if (m.includes('o4-mini') || m.includes('o3-mini'))
    return { input: 1.1, output: 4.4, cacheRead: 0.275, cacheWrite: 0 }
  if (/(^|[^a-z0-9])o3([^a-z0-9]|$)/.test(m)) return { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 }
  // The gpt-5.6 family is priced per codename tier; the bare gpt-5.6 alias routes to
  // sol, so it takes the flagship rate. Earlier gpt-5.x keep the flat family rate.
  if (m.includes('gpt-5.6')) {
    if (m.includes('terra')) return { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 }
    if (m.includes('luna')) return { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 0 }
    return { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 }
  }
  if (m.includes('gpt-5')) return { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 }
  // Google (Gemini). Implicit caching: reads at 0.25x, writes free.
  if (m.includes('gemini') && m.includes('flash'))
    return { input: 0.3, output: 2.5, cacheRead: 0.075, cacheWrite: 0 }
  if (m.includes('gemini')) return { input: 1.25, output: 10, cacheRead: 0.31, cacheWrite: 0 }
  return null
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

/**
 * Best-effort context-window size (in tokens) for a model id, used to show context
 * usage as a percentage. Matches on the model family; returns null for unknown ids
 * (e.g. local/custom models), in which case the UI shows the raw count instead.
 * Approximate — provider context limits change over time.
 */
export function contextWindowFor(model: string): number | null {
  const m = model.toLowerCase()
  if (m.includes('claude')) {
    // Opus and Sonnet 4.6+ (incl. 5.x and beyond), plus Fable/Mythos, ship a 1M-token
    // window as the standard (and default) window — GA, standard-priced, no beta
    // header required. The version ranges keep future minor/major bumps (Opus 4.9,
    // Opus 5) on 1M instead of falling back. Haiku and older Claude families (3.x,
    // and Opus/Sonnet ≤4.5) remain at 200K.
    if (/opus-(4-[6-9]|[5-9])|sonnet-(4-[6-9]|[5-9])|fable|mythos/.test(m)) return 1_000_000
    return 200_000
  }
  if (m.includes('gemini')) return 1_000_000
  // The gpt-5.6 family (sol/terra/luna tiers, and the bare gpt-5.6 alias) ships a
  // 1M-token window; the minor-version range keeps future 5.x bumps on it, like the
  // Claude ranges above. gpt-5 through gpt-5.5 (and their -mini/-nano) stay at 400K.
  if (/gpt-5\.[6-9]/.test(m)) return 1_000_000
  if (m.includes('gpt-5')) return 400_000
  if (m.includes('gpt-4.1')) return 1_000_000
  if (m.includes('gpt-4o')) return 128_000
  if (m.includes('gpt-4')) return 128_000
  if (m.includes('gpt-3.5')) return 16_385
  // o-series reasoning models (o1, o3, o4, o5, …); `o\d` so future ones aren't pinned.
  if (/(^|[^a-z0-9])o\d([^a-z0-9]|$)/.test(m)) return 200_000
  return null
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
 * Vision: Claude 3+/4, GPT-4o / GPT-4.1, the o-series, GPT-5, Gemini 1.5 / 2.x.
 * Reasoning: the o-series, GPT-5, Claude thinking-capable (3.7 & 4.x), and
 * Gemini 2.5. The reasoning heuristics intentionally mirror the per-provider
 * gates in main/providers/reasoning.ts so the UI and the API agree on which
 * models actually accept a thinking/reasoning parameter.
 */
export function modelCapabilities(model: string): ModelCapabilities {
  const m = model.toLowerCase()
  return { vision: hasVision(m), reasoning: hasReasoning(m) }
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

function hasVision(m: string): boolean {
  // Anthropic: Claude 3, 3.5, 3.7, and 4 families are all multimodal. (Claude 2
  // and earlier were text-only, but those ids are long retired.)
  if (m.includes('claude')) {
    return !/claude-(instant|1|2)([^0-9]|$)/.test(m)
  }
  // OpenAI: GPT-4o, GPT-4.1, GPT-5, and the reasoning o-series accept images;
  // legacy text-only gpt-4 / gpt-3.5 do not.
  if (m.includes('gpt-4o') || m.includes('gpt-4.1') || m.includes('gpt-5')) return true
  if (isOSeries(m)) return true
  // Google: Gemini 1.5 and everything from 2.x on are multimodal; 1.0 (gemini-pro) was
  // text-only. The 3.x line has to be listed explicitly — the old `2\.`-only pattern
  // reported every Gemini 3 model as text-only.
  if (m.includes('gemini')) return /gemini[^0-9]*(1\.5|2\.|3)/.test(m)
  return false
}

function hasReasoning(m: string): boolean {
  // OpenAI o-series and GPT-5 are reasoning models. Mirrors the heuristic in
  // main/providers/reasoning.ts (openaiSupportsReasoning): an "o<digit>" or
  // "gpt-5" at the start of the id.
  if (/^(o\d|gpt-5)/.test(m)) return true
  // Anthropic extended thinking — Claude 3.7, the 4.x family, and Fable / Mythos.
  // Mirrors anthropicSupportsThinking in main/providers/reasoning.ts.
  if (/claude.*(3-7|sonnet-4|opus-4|haiku-4|-4-|fable|mythos)/.test(m)) return true
  // Google: the Gemini 2.5 and 3.x lines ("thinking") reason. Mirrors geminiSupportsThinking
  // in main/providers/reasoning.ts — keep the two in lockstep.
  if (m.includes('gemini') && /2\.5|thinking|gemini-3/.test(m)) return true
  return false
}

/** Matches the OpenAI reasoning o-series (o1 / o3 / o4) without false-positiving on words like "llama". */
function isOSeries(m: string): boolean {
  return /(^|[^a-z0-9])o[134](-[a-z]+)?([^a-z0-9]|$)/.test(m)
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
