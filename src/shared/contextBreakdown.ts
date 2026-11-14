import type { ContextParts } from './agent'
import { formatTokens } from './usage'

/**
 * `/context`: what fills the context window now, as both clients show it. The parts
 * are estimates (about four characters per token, see `estimateContextParts`); the
 * provider's measured size of the same request, when it reported one, is shown as
 * the total. Pure, so the desktop panel and the terminal report agree.
 */

export interface ContextRow {
  key: keyof ContextParts
  label: string
  /** What the part is, for a tooltip or a second line. */
  hint: string
  tokens: number
}

const ROWS: { key: keyof ContextParts; label: string; hint: string }[] = [
  { key: 'system', label: "Houston's instructions", hint: 'The system prompt Houston writes for every request' },
  { key: 'tools', label: 'Tool definitions', hint: 'The tools offered to the model, built in and from MCP servers' },
  { key: 'instructions', label: 'Project instructions', hint: 'Rules files such as AGENTS.md, and your own prompt addition' },
  { key: 'memory', label: 'Memories', hint: 'The index of saved memories' },
  { key: 'conversation', label: 'Conversation', hint: 'Your messages, the replies, tool calls and summaries' },
  { key: 'toolResults', label: 'Tool results', hint: 'File contents, command output and search results' }
]

/** The parts in display order, each with its label. */
export function contextRows(parts: ContextParts): ContextRow[] {
  return ROWS.map((r) => ({ ...r, tokens: Math.max(0, Math.round(parts[r.key] ?? 0)) }))
}

/** The estimated request size: the sum of the parts. */
export function contextEstimate(parts: ContextParts): number {
  return contextRows(parts).reduce((n, r) => n + r.tokens, 0)
}

/** A part's share of the estimate, as a whole percentage. */
export function contextShare(tokens: number, estimate: number): number {
  return estimate > 0 ? Math.round((tokens / estimate) * 100) : 0
}

/** Shown wherever the breakdown is, so the figures are never read as exact. */
export const CONTEXT_APPROX_NOTE =
  'Parts are estimated at about four characters per token, so they are approximate. The total is what the provider measured, when it reports one.'

/**
 * Where the context stands against the model's long-context price tier, or null when
 * it has none. Past the boundary every token of a request bills at the higher rate,
 * which is why automatic compaction keeps the window under it.
 */
export function priceTierNote(total: number, tierAbove: number | null | undefined): string | null {
  if (!tierAbove || tierAbove <= 0) return null
  const at = formatTokens(tierAbove)
  return total > tierAbove
    ? `Past this model's long-context price tier: requests over ${at} tokens bill at a higher rate.`
    : `This model bills requests over ${at} tokens at a higher long-context rate.`
}

/**
 * The terminal's `/context` report: one line per part with its share, then the total
 * against the model's window. `measured` is the provider's count for the request
 * (0 when it reported none) and `window` the model's context window, when known.
 */
export function renderContextReport(
  parts: ContextParts | null,
  measured: number,
  window: number | null,
  tierAbove: number | null = null
): string {
  if (!parts) return 'No context yet: send a message, and /context shows what fills the window.'
  const rows = contextRows(parts)
  const estimate = contextEstimate(parts)
  const width = Math.max(...rows.map((r) => r.label.length))
  const lines = rows.map(
    (r) => `  ${r.label.padEnd(width)}  ~${formatTokens(r.tokens).padStart(6)}  ${String(contextShare(r.tokens, estimate)).padStart(3)}%`
  )
  const total = measured > 0 ? measured : estimate
  const tier = priceTierNote(total, tierAbove)
  const of = window ? ` of ${formatTokens(window)} (${Math.min(100, Math.round((total / window) * 100))}%)` : ''
  return [
    'What fills the context window (approximate):',
    ...lines,
    `  ${'Total'.padEnd(width)}  ${measured > 0 ? ' ' : '~'}${formatTokens(total).padStart(6)}${of}`,
    ...(tier ? [tier] : []),
    CONTEXT_APPROX_NOTE
  ].join('\n')
}
