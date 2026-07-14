import type { ModelCaps } from '@shared/types'

/**
 * Per-route prompt-caching configuration for OpenAI-compatible hosts, the
 * counterpart of the per-provider gates in `reasoning.ts`.
 *
 * Caching comes in two families. Automatic upstreams (OpenAI, Grok, Groq,
 * DeepSeek, Gemini implicit) cache server-side with nothing in the request —
 * their savings arrive on their own and their usage split is read back in the
 * adapters. Explicit upstreams (Anthropic Claude, Alibaba Qwen, Gemini explicit)
 * cache only when the request carries `cache_control` breakpoints, which
 * aggregator hosts pass through to the upstream. Without them, an agent loop
 * re-bills its entire prefix at the full input rate every turn.
 */

/**
 * Whether to send Anthropic-style `cache_control` breakpoints on an
 * OpenAI-compatible request. Two gates, both required:
 *
 * - **The host lists a cache-write price for the model** (`caps.cacheWritePrice`
 *   from its `/models` listing). That's the discoverable signal that the route
 *   bills explicit cache writes at all. Hand-typed model ids and plain servers
 *   (vLLM, llama.cpp, gateways) carry no such caps, so they are never sent the
 *   nonstandard field — a strict server can reject unknown request shapes.
 * - **The model family requires explicit breakpoints** (Claude / Qwen / Gemini).
 *   Automatic-caching upstreams need nothing in the request even when the host
 *   lists cache pricing for them, so sending breakpoints there is pure noise.
 *
 * Only iterative loops should enable this: a cache write bills a surcharge that
 * pays off on the next turn's read, so one-shot calls (title, compaction) would
 * pay the surcharge with no read to recoup it.
 */
export function needsExplicitCacheControl(model: string, caps?: ModelCaps): boolean {
  if (caps?.cacheWritePrice === undefined || caps.cacheWritePrice <= 0) return false
  return /claude|qwen|gemini/i.test(model)
}
