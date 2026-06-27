/**
 * Token-usage helpers shared by the main process (which reports raw counts from
 * each provider) and the renderer (which displays them). Pure + dependency-free
 * so both processes and the unit tests can use them.
 */

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
}

/**
 * Best-effort USD price per 1M tokens for a model id, matched by family. Returns
 * null for unknown / local models (Ollama, LM Studio), in which case no cost is
 * shown. Approximate — provider prices change over time; this is a rough guide,
 * not a billing source of truth.
 */
export function modelPricing(model: string): ModelPricing | null {
  const m = model.toLowerCase()
  // Anthropic (Claude) — current per-MTok rates for the 4.x line.
  if (m.includes('opus')) return { input: 5, output: 25 }
  if (m.includes('sonnet')) return { input: 3, output: 15 }
  if (m.includes('haiku')) return { input: 1, output: 5 }
  // OpenAI (GPT / o-series)
  if (m.includes('gpt-4o-mini')) return { input: 0.15, output: 0.6 }
  if (m.includes('gpt-4o')) return { input: 2.5, output: 10 }
  if (m.includes('gpt-4.1-mini')) return { input: 0.4, output: 1.6 }
  if (m.includes('gpt-4.1')) return { input: 2, output: 8 }
  if (m.includes('o4-mini') || m.includes('o3-mini')) return { input: 1.1, output: 4.4 }
  if (/(^|[^a-z0-9])o3([^a-z0-9]|$)/.test(m)) return { input: 2, output: 8 }
  if (m.includes('gpt-5')) return { input: 1.25, output: 10 }
  // Google (Gemini)
  if (m.includes('gemini') && m.includes('flash')) return { input: 0.3, output: 2.5 }
  if (m.includes('gemini')) return { input: 1.25, output: 10 }
  return null
}

/** Estimated USD cost of one turn's tokens for `model` (0 when the price is unknown). */
export function turnCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = modelPricing(model)
  if (!p) return 0
  const inTok = Number.isFinite(inputTokens) && inputTokens > 0 ? inputTokens : 0
  const outTok = Number.isFinite(outputTokens) && outputTokens > 0 ? outputTokens : 0
  return (inTok / 1_000_000) * p.input + (outTok / 1_000_000) * p.output
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
    // Opus 4.6/4.7/4.8, Sonnet 4.6, and Fable/Mythos ship a 1M-token window as the
    // standard (and default) window — GA, standard-priced, no beta header required.
    // Haiku 4.5 and older Claude families remain at 200K.
    if (/opus-4-[678]|sonnet-4-6|fable|mythos/.test(m)) return 1_000_000
    return 200_000
  }
  if (m.includes('gemini')) return 1_000_000
  if (m.includes('gpt-5')) return 400_000
  if (m.includes('gpt-4.1')) return 1_000_000
  if (m.includes('gpt-4o')) return 128_000
  if (m.includes('gpt-4')) return 128_000
  if (m.includes('gpt-3.5')) return 16_385
  if (/(^|[^a-z0-9])o[134]([^a-z0-9]|$)/.test(m)) return 200_000 // o1 / o3 / o4 reasoning models
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
  // Google: Gemini 1.5 and 2.x are multimodal; 1.0 (gemini-pro) was text-only.
  if (m.includes('gemini')) return /gemini[^0-9]*(1\.5|2\.)/.test(m)
  return false
}

function hasReasoning(m: string): boolean {
  // OpenAI o-series and GPT-5 are reasoning models. Mirrors the heuristic in
  // main/providers/reasoning.ts (openaiSupportsReasoning): an "o<digit>" or
  // "gpt-5" at the start of the id.
  if (/^(o\d|gpt-5)/.test(m)) return true
  // Anthropic extended thinking — Claude 3.7 and the 4.x family. Mirrors
  // anthropicSupportsThinking in main/providers/reasoning.ts.
  if (/claude.*(3-7|sonnet-4|opus-4|haiku-4|-4-)/.test(m)) return true
  // Google: Gemini 2.5 ("thinking") models reason. Mirrors geminiSupportsThinking.
  if (m.includes('gemini') && /2\.5|thinking/.test(m)) return true
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
