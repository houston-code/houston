import type { ReasoningEffort, ReasoningSummary } from '@shared/agent'

/**
 * Per-provider reasoning ("extended thinking") configuration. Each provider only
 * supports it on certain models — sending a thinking/reasoning parameter to a
 * model that lacks it is an API error — so every helper is gated on a model-name
 * heuristic and returns `null`/`undefined` when reasoning shouldn't be sent.
 */

type OnEffort = 'low' | 'medium' | 'high' | 'xhigh'

function isOn(effort: ReasoningEffort | undefined): effort is OnEffort {
  return effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh'
}

/** Providers without an `xhigh` tier clamp it to their maximum (`high`). */
function clampToHigh(effort: OnEffort): 'low' | 'medium' | 'high' {
  return effort === 'xhigh' ? 'high' : effort
}

/**
 * Per-effort token sizing for Anthropic. On legacy models this is the literal
 * `budget_tokens` for extended thinking; on adaptive-thinking models (which have
 * no budget) it sizes `max_tokens` so the reply keeps the same headroom it had
 * before, leaving output ceilings unchanged across the two APIs.
 */
const ANTHROPIC_BUDGET: Record<'low' | 'medium' | 'high', number> = {
  low: 4096,
  medium: 10_000,
  high: 16_000
}

/** Extra output tokens to allow on top of the thinking budget for the reply. */
export const ANTHROPIC_REPLY_HEADROOM = 8192

/** Claude models that support thinking at all (3.7, the 4.x family, and Fable / Mythos). */
export function anthropicSupportsThinking(model: string): boolean {
  return /claude.*(3-7|sonnet-4|opus-4|haiku-4|-4-|fable|mythos)/i.test(model)
}

/**
 * Claude models that predate adaptive thinking and still take the legacy
 * `{ type: 'enabled', budget_tokens }` API (they also reject `output_config.effort`):
 * Claude 3.7, the 4.0 / 4.1 / 4.5 lines, and Haiku 4.5. Everything newer
 * (Opus 4.6+, Sonnet 4.6+, Fable, Mythos) uses adaptive thinking + effort — and
 * the Opus 4.7/4.8 line *rejects* the legacy shape with a 400, which is the bug
 * this gating exists to prevent. The default is adaptive so a future model is
 * never silently routed onto the removed legacy parameter.
 */
export function anthropicUsesLegacyThinking(model: string): boolean {
  return (
    /claude-3-7/i.test(model) || // Claude 3.7
    /claude-(opus|sonnet)-4-\d{8}/i.test(model) || // Opus/Sonnet 4.0 (dated snapshots)
    /claude-opus-4-1\b/i.test(model) || // Opus 4.1
    /claude-opus-4-5\b/i.test(model) || // Opus 4.5
    /claude-sonnet-4-5\b/i.test(model) || // Sonnet 4.5
    /claude-haiku-4-5\b/i.test(model) // Haiku 4.5 (no effort support)
  )
}

/**
 * The `xhigh` effort tier exists only on Opus 4.7+ (and Fable / Mythos); older
 * effort-capable models top out at `high`, so `xhigh` is clamped there.
 */
export function anthropicSupportsXhigh(model: string): boolean {
  return /claude-(opus-4-(7|8)|fable|mythos)/i.test(model)
}

/**
 * Legacy budget-thinking models that support **interleaved thinking** via the
 * `interleaved-thinking-2025-05-14` beta header — the Claude 4.x Opus/Sonnet line
 * (4.0 dated snapshots, 4.1, 4.5). It lets the model reason about each tool
 * result before its next action instead of thinking only once per turn.
 *
 * Excludes Claude 3.7 (predates the feature) and Haiku 4.5 (accepts but ignores
 * the header). Adaptive-thinking models (4.6+, Fable, Mythos) interleave
 * automatically and never take this header, so they're out of scope here.
 */
export function anthropicSupportsInterleavedThinking(model: string): boolean {
  return /claude-(opus|sonnet)-4-(\d{8}|1|5)\b/i.test(model)
}

/** Anthropic reasoning config: adaptive thinking (4.6+) or legacy budget thinking. */
export type AnthropicThinking =
  | { kind: 'adaptive'; effort: OnEffort; display: 'summarized'; maxTokens: number }
  | { kind: 'budget'; budgetTokens: number; maxTokens: number; interleaved: boolean }

/**
 * Anthropic reasoning config + the `max_tokens` to pair it with. Newer models
 * (4.6+) use adaptive thinking driven by `output_config.effort`; pre-4.6 models
 * and Haiku 4.5 use the legacy `{ type: 'enabled', budget_tokens }` API (budget
 * must be < max_tokens). Returns null when reasoning is off or unsupported.
 */
export function anthropicThinking(
  model: string,
  effort: ReasoningEffort | undefined
): AnthropicThinking | null {
  if (!isOn(effort) || !anthropicSupportsThinking(model)) return null
  const budgetTokens = ANTHROPIC_BUDGET[clampToHigh(effort)]
  const maxTokens = budgetTokens + ANTHROPIC_REPLY_HEADROOM
  if (anthropicUsesLegacyThinking(model)) {
    return {
      kind: 'budget',
      budgetTokens,
      maxTokens,
      interleaved: anthropicSupportsInterleavedThinking(model)
    }
  }
  // Adaptive thinking: request a summary so the UI keeps streaming reasoning —
  // the 4.7/4.8 default is `omitted`, which would surface an empty thinking stream.
  return {
    kind: 'adaptive',
    effort: anthropicSupportsXhigh(model) ? effort : clampToHigh(effort),
    display: 'summarized',
    maxTokens
  }
}

/** OpenAI reasoning models (o-series and gpt-5) accept `reasoning_effort`. */
export function openaiSupportsReasoning(model: string): boolean {
  return /^(o\d|gpt-5)/i.test(model)
}

/**
 * The Chat Completions `reasoning_effort` value, or undefined when off/unsupported.
 * Chat Completions tops out at `high`, so `xhigh` is clamped (only the Responses
 * API path accepts `xhigh`).
 *
 * `capable` is the host's listed reasoning support (from `ModelOption.caps`): when
 * provided it overrides the id heuristic, so a host-routed reasoning model the regex
 * doesn't recognize (`deepseek/deepseek-r1`) still gets `reasoning_effort`, and a
 * model the host says can't reason is never sent one. Absent → use the heuristic.
 */
export function openaiReasoningEffort(
  model: string,
  effort: ReasoningEffort | undefined,
  capable?: boolean
): 'low' | 'medium' | 'high' | undefined {
  const supported = capable ?? openaiSupportsReasoning(model)
  if (!isOn(effort) || !supported) return undefined
  return clampToHigh(effort)
}

/**
 * Reasoning config for the OpenAI **Responses API**: the effort (incl. `xhigh`)
 * plus how to request the reasoning summary so the user can see the model's
 * thinking. `summary: 'none'` omits the summary request. Returns undefined when
 * reasoning is off or the model doesn't support it.
 */
export function openaiResponsesReasoning(
  model: string,
  effort: ReasoningEffort | undefined,
  summary?: ReasoningSummary
): { effort: OnEffort; summary?: 'auto' | 'concise' | 'detailed' } | undefined {
  if (!isOn(effort) || !openaiSupportsReasoning(model)) return undefined
  if (summary === 'none') return { effort }
  return { effort, summary: summary ?? 'auto' }
}

/** Gemini thinking budgets per effort level. */
const GEMINI_BUDGET: Record<'low' | 'medium' | 'high', number> = {
  low: 4096,
  medium: 10_000,
  high: 16_000
}

/** Gemini 2.5 models support a configurable thinking budget. */
export function geminiSupportsThinking(model: string): boolean {
  return /2\.5|thinking/i.test(model)
}

/** Gemini `thinkingBudget`, or undefined when off/unsupported. */
export function geminiThinkingBudget(
  model: string,
  effort: ReasoningEffort | undefined
): number | undefined {
  if (!isOn(effort) || !geminiSupportsThinking(model)) return undefined
  return GEMINI_BUDGET[clampToHigh(effort)]
}
