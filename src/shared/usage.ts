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
}

/**
 * Best-effort context-window size (in tokens) for a model id, used to show context
 * usage as a percentage. Matches on the model family; returns null for unknown ids
 * (e.g. local/custom models), in which case the UI shows the raw count instead.
 * Approximate — provider context limits change over time.
 */
export function contextWindowFor(model: string): number | null {
  const m = model.toLowerCase()
  if (m.includes('claude')) return 200_000
  if (m.includes('gemini')) return 1_000_000
  if (m.includes('gpt-4.1')) return 1_000_000
  if (m.includes('gpt-4o')) return 128_000
  if (m.includes('gpt-4')) return 128_000
  if (m.includes('gpt-3.5')) return 16_385
  if (/(^|[^a-z0-9])o[134]([^a-z0-9]|$)/.test(m)) return 200_000 // o1 / o3 / o4 reasoning models
  return null
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
