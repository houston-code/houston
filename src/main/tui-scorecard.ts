import type { ModelScorecard, Scorecard } from '@shared/scorecard'
import { formatTokens, formatUsd } from '@shared/usage'
import type { Painter } from './tui'
import { stripControlChars } from './tui-wrap'

/**
 * `/scorecard` in the terminal: the desktop's loop scorecard (how each model has
 * behaved across the chats on this computer) as text, from the same report
 * (`computeScorecard`, aggregated on-device). Pure, so the layout is testable.
 */

/** Tools listed per model, most used first. */
export const SCORECARD_TOP_TOOLS = 5

const money = (n: number): string => (n > 0 ? `≈${formatUsd(n)}` : '–')

function modelBlock(m: ModelScorecard, paint: Painter): string[] {
  const pct = Math.round(m.completionRate * 100)
  const lines = [
    `${paint(stripControlChars(m.model), 'bold')}  ${paint(`${m.runs} run${m.runs === 1 ? '' : 's'}`, 'dim')}`,
    `  avg steps ${m.avgSteps} · avg tools ${m.avgToolCalls} · clean finish ${pct}% (${m.completedRuns} of ${m.runs}) · cost ${money(m.totalCost)}${
      m.totalCost > 0 ? ` (${money(m.avgCost)} per run)` : ''
    } · output ${formatTokens(m.totalOutputTokens)}`
  ]
  if (m.tools.length) {
    const top = m.tools.slice(0, SCORECARD_TOP_TOOLS).map((t) => `${stripControlChars(t.name)} ${t.count}`)
    const more = m.tools.length - SCORECARD_TOP_TOOLS
    lines.push(paint(`  tools: ${top.join(', ')}${more > 0 ? `, +${more} more` : ''}`, 'dim'))
  }
  return lines
}

export function renderScorecard(card: Scorecard, paint: Painter): string {
  if (card.models.length === 0) {
    return paint("· no runs yet; once you've chatted with a model, its stats show here", 'dim')
  }
  const head = `${paint('Loop scorecard', 'bold')}  ${card.totalRuns} run${card.totalRuns === 1 ? '' : 's'}${
    card.totalCost > 0 ? ` · ${money(card.totalCost)}` : ''
  }`
  const lines = [head, paint('  How each model has behaved across your chats, from this computer only. Figures are approximate.', 'dim'), '']
  card.models.forEach((m, i) => {
    if (i) lines.push('')
    lines.push(...modelBlock(m, paint))
  })
  return lines.join('\n')
}
