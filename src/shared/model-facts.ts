/**
 * Everything Houston infers about a model from its id, in one place: price, context
 * window, vision, reasoning, the Claude request-shape traits the API is strict about,
 * and each provider's family ranking for display order. Pure + dependency-free so the
 * main process (request building), the renderer (picker, cost display) and the tests
 * share one definition.
 *
 * Organized by provider, so supporting a new model is one edit in that provider's
 * section rather than a hunt across pricing, windows, capabilities and gates. Each
 * table is ordered most specific first and resolved by first match. Every fact here is
 * pinned per id in src/main/providers/goldens/model-knowledge.json, so a change to what
 * any known id resolves to shows up as a reviewed golden diff.
 *
 * These are heuristics for ids the host doesn't describe. Host-listed metadata
 * (`ModelCaps`) wins where present; see `resolvePricing` / `resolveCapabilities`.
 */

/** Per-million-token prices in USD for a model (input vs output tokens). */
export interface ModelPricing {
  input: number
  output: number
  /**
   * Price per 1M cached-input tokens read back from the prompt cache. Cache-read
   * discounts vary by family (Anthropic 0.1x, GPT-4o 0.5x, GPT-4.1/o-series 0.25x,
   * GPT-5+ 0.1x, Gemini 0.1x), so it's a price, not a shared multiplier. Absent ⇒
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

/** A display-order family: canonical name plus a matcher for a lowercased id. */
export interface FamilyRule {
  /** Canonical family name, used to keep the family's members grouped. */
  name: string
  /** Matches a (lowercased) model id belonging to this family. */
  test: RegExp
}

type Rows<T> = Array<[RegExp, T]>

/** A price on a host whose cache writes are free (OpenAI, Gemini). A missing cached-input
 *  rate means the model has no prompt cache, so a read is billed at the input rate. */
function freeWrites(input: number, output: number, cacheRead?: number): ModelPricing {
  return { input, output, cacheRead: cacheRead ?? input, cacheWrite: 0 }
}

// ── Anthropic (Claude) ────────────────────────────────────────────────────────────
//
// The Claude gates match on a substring so they hold for the same model whichever host
// serves it: Bedrock's vendor-prefixed ids (`anthropic.claude-opus-4-8`) match as-is,
// and Vertex's `@`-dated snapshots (`claude-sonnet-4@20250514`) are why the snapshot
// separator is `[-@]` rather than `-`. Generations are matched as ranges
// (`(opus|sonnet)-[4-9]`) so a minor release lands in its family instead of nowhere.

/** Claude models that support thinking at all: 3.7, Opus / Sonnet / Haiku from 4.x on, and
 *  Fable / Mythos. A miss is silent: the model is sent no thinking config. */
const CLAUDE_THINKING = /claude.*(3-7|(opus|sonnet|haiku)-[4-9]|-4-|fable|mythos)/i

/**
 * Claude models that predate adaptive thinking and still take the legacy
 * `{ type: 'enabled', budget_tokens }` API (they also reject `output_config.effort`).
 * Everything newer uses adaptive thinking + effort, and Opus 4.7+ *rejects* the legacy
 * shape with a 400. The default is adaptive so a new model is never routed onto the
 * removed legacy parameter.
 */
const CLAUDE_LEGACY_THINKING = [
  /claude-3-7/i, // Claude 3.7
  /claude-(opus|sonnet)-4[-@]\d{8}/i, // Opus/Sonnet 4.0 (dated snapshots)
  /claude-opus-4-1\b/i, // Opus 4.1
  /claude-opus-4-5\b/i, // Opus 4.5
  /claude-sonnet-4-5\b/i, // Sonnet 4.5
  /claude-haiku-4-5\b/i // Haiku 4.5 (no effort support)
]

/** Legacy budget-thinking models that take the `interleaved-thinking-2025-05-14` beta:
 *  the Claude 4.x Opus/Sonnet line (4.0 dated snapshots, 4.1, 4.5). Excludes 3.7
 *  (predates it) and Haiku 4.5 (accepts but ignores it). */
const CLAUDE_INTERLEAVED = /claude-(opus|sonnet)-4[-@](\d{8}|1|5)\b/i

/** The `xhigh` effort tier: Opus 4.7+, Sonnet 5+, Fable / Mythos. Opus 4.6 and Sonnet 4.6
 *  top out at `high`. */
const CLAUDE_XHIGH = /claude-(opus-4-[7-9]|opus-[5-9]|sonnet-[5-9]|fable|mythos)/i

/** Prefix-bound ("preserved") thinking: Fable 5.1, Opus 5.5, Sonnet 5.5. Mythos 5.1 doesn't
 *  run the check. */
const CLAUDE_PRESERVED_THINKING = /claude-((opus|sonnet)-5-[5-9]|fable-5-[1-9])/i

const CLAUDE_FAMILIES: FamilyRule[] = [
  { name: 'fable', test: /fable/ },
  { name: 'opus', test: /opus/ },
  { name: 'sonnet', test: /sonnet/ },
  { name: 'haiku', test: /haiku/ }
]

/** Per-MTok rates. Fable / Mythos are the flagship tier, priced above Opus. Cache writes
 *  are 1.25x input everywhere (the absent-field default); cache reads are 0.1x except
 *  where a release cut them (Fable / Mythos 5.1 at 0.025x, Opus 5.5 at 0.05x). Releases
 *  repriced within a family are matched before the family-wide rate. */
const CLAUDE_PRICES: Rows<ModelPricing> = [
  [/(fable|mythos)-5-1/, { input: 10, output: 50, cacheRead: 0.25 }],
  [/fable|mythos/, { input: 10, output: 50 }],
  [/opus-5-5/, { input: 4, output: 20, cacheRead: 0.2 }],
  [/opus/, { input: 5, output: 25 }],
  [/sonnet-[5-9]/, { input: 2, output: 10 }],
  [/sonnet/, { input: 3, output: 15 }],
  [/haiku/, { input: 1, output: 5 }]
]

/** Opus and Sonnet 4.6+ and Fable / Mythos ship a 1M window as standard; Haiku and older
 *  families (3.x, Opus/Sonnet ≤4.5) stay at 200K. */
const CLAUDE_WINDOWS: Rows<number> = [
  [/claude.*(opus-(4-[6-9]|[5-9])|sonnet-(4-[6-9]|[5-9])|fable|mythos)/, 1_000_000],
  [/claude/, 200_000]
]

/** Claude 3 onward is multimodal; Claude 2 / Instant were text-only. */
const CLAUDE_VISION: Rows<boolean> = [
  [/claude-(instant|1|2)([^0-9]|$)/, false],
  [/claude/, true]
]

// ── OpenAI (GPT / o-series) ───────────────────────────────────────────────────────

/** Reasoning models (o-series, and GPT from gpt-5 on) accept `reasoning_effort`. Anchored,
 *  so an aggregator-prefixed id (`openai/gpt-5`) is deliberately not matched. */
const OPENAI_REASONING = /^(o\d|gpt-([5-9]|[1-9]\d))/i

/** The o-series (o1 / o3 / o4) without false-positiving on words like "llama". */
const O_SERIES = /(^|[^a-z0-9])o[134](-[a-z]+)?([^a-z0-9]|$)/

const OPENAI_FAMILIES: FamilyRule[] = [
  // The current GPT generations (5.x, 6.x) form one family that sorts by version, so
  // gpt-6.1 precedes gpt-6 precedes gpt-5.6. More specific rules precede broader ones
  // (gpt-4o before the legacy gpt-4 catch-all).
  { name: 'gpt', test: /gpt-([5-9]|[1-9]\d)/ },
  { name: 'gpt-4.1', test: /gpt-4\.1/ },
  { name: 'gpt-4o', test: /gpt-4o/ },
  { name: 'o-series', test: /(^|[^a-z0-9])o\d/ },
  { name: 'gpt-4', test: /gpt-4/ },
  { name: 'gpt-3', test: /gpt-3/ }
]

/** OpenAI's published standard-tier rates, most specific first (a `-mini` / `-pro` variant
 *  before its base id). A later 6.x release of a codename tier takes that tier's rate. */
const OPENAI_PRICES: Rows<ModelPricing> = [
  [/gpt-6[\d.]*-astra/, freeWrites(10, 50, 1)],
  [/gpt-6-sol/, freeWrites(2, 10, 0.2)],
  [/gpt-6[\d.]*-luna/, freeWrites(0.1, 0.5, 0.01)],
  [/gpt-6/, freeWrites(2, 10, 0.1)], // gpt-6.1-sol and later sol releases
  // GPT-5.6 is priced per tier; the bare gpt-5.6 alias routes to sol.
  [/gpt-5\.6-terra/, freeWrites(2, 12, 0.2)],
  [/gpt-5\.6-luna/, freeWrites(0.2, 1.2, 0.02)],
  [/gpt-5\.6/, freeWrites(4, 20, 0.4)],
  [/gpt-5\.5-pro/, freeWrites(30, 180)],
  [/gpt-5\.5/, freeWrites(5, 30, 0.5)],
  [/gpt-5\.4-pro/, freeWrites(30, 180)],
  [/gpt-5\.4-mini/, freeWrites(0.75, 4.5, 0.075)],
  [/gpt-5\.4-nano/, freeWrites(0.2, 1.25, 0.02)],
  [/gpt-5\.4/, freeWrites(2.5, 15, 0.25)],
  [/gpt-5\.2-pro/, freeWrites(21, 168)],
  [/gpt-5\.2/, freeWrites(1.75, 14, 0.175)],
  [/gpt-5-pro/, freeWrites(15, 120)],
  [/gpt-5-mini/, freeWrites(0.25, 2, 0.025)],
  [/gpt-5-nano/, freeWrites(0.05, 0.4, 0.005)],
  [/gpt-5/, freeWrites(1.25, 10, 0.125)], // gpt-5, gpt-5.1
  [/gpt-4o-mini/, freeWrites(0.15, 0.6, 0.075)],
  [/gpt-4o/, freeWrites(2.5, 10, 1.25)],
  [/gpt-4\.1-mini/, freeWrites(0.4, 1.6, 0.1)],
  [/gpt-4\.1/, freeWrites(2, 8, 0.5)],
  [/(^|[^a-z0-9])o4-mini/, freeWrites(1.1, 4.4, 0.275)],
  [/(^|[^a-z0-9])o3-mini/, freeWrites(1.1, 4.4, 0.55)],
  [/(^|[^a-z0-9])o3-pro/, freeWrites(20, 80)],
  [/(^|[^a-z0-9])o3([^a-z0-9]|$)/, freeWrites(2, 8, 0.5)],
  [/(^|[^a-z0-9])o1-pro/, freeWrites(150, 600)],
  [/(^|[^a-z0-9])o1([^a-z0-9]|$)/, freeWrites(15, 60, 7.5)]
]

/** GPT-6 ships 1.05M on every tier; gpt-5.6 ships 1M; gpt-5 through 5.5 stay at 400K. The
 *  o-series is `o\d` so a later one isn't pinned. */
const OPENAI_WINDOWS: Rows<number> = [
  [/gpt-([6-9]|[1-9]\d)/, 1_050_000],
  [/gpt-5\.[6-9]/, 1_000_000],
  [/gpt-5/, 400_000],
  [/gpt-4\.1/, 1_000_000],
  [/gpt-4/, 128_000], // gpt-4o and legacy gpt-4
  [/gpt-3\.5/, 16_385],
  [/(^|[^a-z0-9])o\d([^a-z0-9]|$)/, 200_000]
]

/** GPT-4o, GPT-4.1, GPT-5 on, and the o-series accept images; legacy gpt-4 / 3.5 don't. */
const OPENAI_VISION: Rows<boolean> = [
  [/gpt-4o|gpt-4\.1|gpt-([5-9]|[1-9]\d)/, true],
  [O_SERIES, true]
]

// ── Google (Gemini) ───────────────────────────────────────────────────────────────

/** Configurable thinking budget: the 2.5 and 3.x lines, plus anything named "thinking".
 *  Unguarded because it only ever runs on a Gemini provider's ids. */
const GEMINI_THINKING = /2\.5|thinking|gemini-3/i

const GEMINI_FAMILIES: FamilyRule[] = [
  { name: 'pro', test: /pro/ },
  { name: 'flash', test: /flash/ }
]

/** Rates vary by release rather than by tier, so specific ids precede each tier's fallback
 *  (lite before flash, which it contains). Cache reads are 0.1x, implicit-cache writes are
 *  free, and Pro prices are the <=200K-prompt tier. 3.5-flash-lite has no context caching,
 *  so its reads are priced at input. The 3.6-3.8 Flash rate doubles on 2027-01-01 per
 *  Google's pricing page. */
const GEMINI_PRICES: Rows<ModelPricing> = [
  [/gemini.*3\.5.*flash-lite|gemini.*flash-lite.*3\.5/, freeWrites(0.3, 2.5)],
  [/gemini.*2\.5.*flash-lite|gemini.*flash-lite.*2\.5/, freeWrites(0.1, 0.4, 0.01)],
  [/gemini.*flash-lite/, freeWrites(0.25, 1.5, 0.025)], // 3.1
  [/gemini.*3\.5.*flash|gemini.*flash.*3\.5/, freeWrites(1.5, 9, 0.15)],
  [/gemini-3-flash/, freeWrites(0.5, 3, 0.05)],
  [/gemini.*2\.5.*flash|gemini.*flash.*2\.5/, freeWrites(0.3, 2.5, 0.03)],
  [/gemini.*flash/, freeWrites(0.75, 3.75, 0.075)], // 3.6-3.8
  [/gemini-3/, freeWrites(2, 12, 0.2)], // 3.x Pro
  [/gemini/, freeWrites(1.25, 10, 0.125)] // 2.5 Pro
]

const GEMINI_WINDOWS: Rows<number> = [[/gemini/, 1_000_000]]

/** Gemini 1.5 and everything from 2.x on are multimodal; 1.0 (`gemini-pro`) was text-only. */
const GEMINI_VISION: Rows<boolean> = [
  [/gemini[^0-9]*(1\.5|2\.|3)/, true],
  [/gemini/, false]
]

// ── Resolution ────────────────────────────────────────────────────────────────────

/** Display-order family rules per provider kind. Hosted-Claude kinds rank by the Claude
 *  families (their SDKs are Claude clients); Azure OpenAI and OpenAI-compatible hosts by
 *  the OpenAI families, falling through to generic grouping for ids they don't match. */
export const FAMILY_RULES = {
  anthropic: CLAUDE_FAMILIES,
  bedrock: CLAUDE_FAMILIES,
  vertex: CLAUDE_FAMILIES,
  foundry: CLAUDE_FAMILIES,
  openai: OPENAI_FAMILIES,
  'openai-compatible': OPENAI_FAMILIES,
  'azure-openai': OPENAI_FAMILIES,
  gemini: GEMINI_FAMILIES
} as const satisfies Record<string, FamilyRule[]>

function firstMatch<T>(rows: Rows<T>, m: string): T | undefined {
  return rows.find(([re]) => re.test(m))?.[1]
}

/** Best-effort USD price per 1M tokens, or null for unknown / local models. Approximate:
 *  provider prices change, so this is a guide, not a billing source of truth. */
export function modelPricing(model: string): ModelPricing | null {
  const m = model.toLowerCase()
  return (
    firstMatch(CLAUDE_PRICES, m) ??
    firstMatch(OPENAI_PRICES, m) ??
    (m.includes('gemini') ? firstMatch(GEMINI_PRICES, m) : undefined) ??
    null
  )
}

/** Best-effort context window in tokens, or null for unknown ids (the UI then shows the
 *  raw count). */
export function contextWindowFor(model: string): number | null {
  const m = model.toLowerCase()
  return (
    firstMatch(CLAUDE_WINDOWS, m) ?? firstMatch(GEMINI_WINDOWS, m) ?? firstMatch(OPENAI_WINDOWS, m) ?? null
  )
}

/** Whether the model accepts image inputs. Unknown ids report false. */
export function modelHasVision(model: string): boolean {
  const m = model.toLowerCase()
  return firstMatch(CLAUDE_VISION, m) ?? firstMatch(OPENAI_VISION, m) ?? firstMatch(GEMINI_VISION, m) ?? false
}

/** Whether the model has a reasoning mode the request can turn on. The union of the
 *  per-provider gates below, so the UI toggle and the request agree by construction. */
export function modelHasReasoning(model: string): boolean {
  const m = model.toLowerCase()
  return (
    openaiSupportsReasoning(m) ||
    anthropicSupportsThinking(m) ||
    // Guarded here (unlike the request-side gate, which only sees Gemini ids) so an
    // unrelated id like `qwen2.5-coder` doesn't read as a thinking model.
    (m.includes('gemini') && geminiSupportsThinking(m))
  )
}

export function anthropicSupportsThinking(model: string): boolean {
  return CLAUDE_THINKING.test(model)
}

export function anthropicUsesLegacyThinking(model: string): boolean {
  return CLAUDE_LEGACY_THINKING.some((re) => re.test(model))
}

export function anthropicSupportsInterleavedThinking(model: string): boolean {
  return CLAUDE_INTERLEAVED.test(model)
}

export function anthropicSupportsXhigh(model: string): boolean {
  return CLAUDE_XHIGH.test(model)
}

/**
 * Prefix-bound thinking: replaying one of these models' blocks after any edit to the
 * earlier history is a 400 on accounts created on or after 2026-08-31, and Houston edits
 * history by design (keep-tail compaction, stale tool-result stubbing). Requests to these
 * models opt into the `drop_block` mismatch behavior instead.
 */
export function anthropicPreservesThinking(model: string): boolean {
  return CLAUDE_PRESERVED_THINKING.test(model)
}

export function openaiSupportsReasoning(model: string): boolean {
  return OPENAI_REASONING.test(model)
}

export function geminiSupportsThinking(model: string): boolean {
  return GEMINI_THINKING.test(model)
}
