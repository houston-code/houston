import type { ReasoningEffort } from '@shared/agent'

/**
 * Per-provider reasoning ("extended thinking") configuration. Each provider only
 * supports it on certain models — sending a thinking/reasoning parameter to a
 * model that lacks it is an API error — so every helper is gated on a model-name
 * heuristic and returns `null`/`undefined` when reasoning shouldn't be sent.
 */

function isOn(effort: ReasoningEffort | undefined): effort is 'low' | 'medium' | 'high' {
  return effort === 'low' || effort === 'medium' || effort === 'high'
}

/** Anthropic thinking token budgets per effort level. */
const ANTHROPIC_BUDGET: Record<'low' | 'medium' | 'high', number> = {
  low: 4096,
  medium: 10_000,
  high: 16_000
}

/** Extra output tokens to allow on top of the thinking budget for the reply. */
export const ANTHROPIC_REPLY_HEADROOM = 8192

/** Claude models that support extended thinking (3.7 and the 4.x family). */
export function anthropicSupportsThinking(model: string): boolean {
  return /claude.*(3-7|sonnet-4|opus-4|haiku-4|-4-)/i.test(model)
}

/**
 * Anthropic `thinking` config + the `max_tokens` it requires (budget must be
 * strictly less than max_tokens). Returns null when reasoning is off/unsupported.
 */
export function anthropicThinking(
  model: string,
  effort: ReasoningEffort | undefined
): { budgetTokens: number; maxTokens: number } | null {
  if (!isOn(effort) || !anthropicSupportsThinking(model)) return null
  const budgetTokens = ANTHROPIC_BUDGET[effort]
  return { budgetTokens, maxTokens: budgetTokens + ANTHROPIC_REPLY_HEADROOM }
}

/** OpenAI reasoning models (o-series and gpt-5) accept `reasoning_effort`. */
export function openaiSupportsReasoning(model: string): boolean {
  return /^(o\d|gpt-5)/i.test(model)
}

/** The `reasoning_effort` value to send, or undefined when off/unsupported. */
export function openaiReasoningEffort(
  model: string,
  effort: ReasoningEffort | undefined
): 'low' | 'medium' | 'high' | undefined {
  if (!isOn(effort) || !openaiSupportsReasoning(model)) return undefined
  return effort
}

/**
 * Reasoning config for the OpenAI **Responses API**: the effort plus a request
 * for a reasoning summary (so the user can see the model's thinking). Returns
 * undefined when reasoning is off or the model doesn't support it.
 */
export function openaiResponsesReasoning(
  model: string,
  effort: ReasoningEffort | undefined
): { effort: 'low' | 'medium' | 'high'; summary: 'auto' } | undefined {
  if (!isOn(effort) || !openaiSupportsReasoning(model)) return undefined
  return { effort, summary: 'auto' }
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
  return GEMINI_BUDGET[effort]
}
