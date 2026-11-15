import type { UsageReport, UsageTotals } from '@shared/usageReport'
import { formatTokens, formatUsd } from '@shared/usage'
import type { Painter } from './tui'
import { stripControlChars } from './tui-wrap'
import { rateLimitLine, type RateLimitState } from '@shared/rateLimitState'

/**
 * `/usage` in the terminal: the desktop's usage view as a compact text table, from
 * the same report (`buildUsageReport`, summed in the main process from the chats
 * saved on this computer). Pure, so the layout is testable.
 */

/** Days the terminal table shows, newest last. The report itself covers 30. */
export const TUI_USAGE_DAYS = 7
/** Projects the terminal table shows, most expensive first. */
export const TUI_USAGE_PROJECTS = 5

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** "Fri Nov 13" for a YYYY-MM-DD local date (fixed English, so the columns line up). */
export function usageDayLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  const t = new Date(y, m - 1, d, 12)
  return `${WEEKDAYS[t.getDay()]} ${MONTHS[t.getMonth()]} ${String(d).padStart(2, ' ')}`
}

/** A money figure, or a dash when nothing was priced. */
const money = (n: number): string => (n > 0 ? formatUsd(n) : '–')

function row(cells: string[], widths: number[]): string {
  return cells
    .map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i])))
    .join('  ')
    .trimEnd()
}

function totalsLine(label: string, t: UsageTotals): string {
  return `${label} ${money(t.cost)}  (${formatTokens(t.inputTokens)} in, ${formatTokens(t.outputTokens)} out)`
}

export function renderUsageReport(report: UsageReport, paint: Painter): string {
  const lines: string[] = [
    paint('Usage', 'bold'),
    paint('  From the chats saved on this computer; nothing is sent anywhere. Costs are list-price estimates.', 'dim'),
    ''
  ]
  if (report.allTime.chats === 0) {
    lines.push(paint('  No spend recorded yet.', 'dim'))
    return lines.join('\n')
  }

  const days = report.days.slice(-TUI_USAGE_DAYS)
  const dayRows = days.map((d) =>
    d.replies === 0 && d.cost <= 0
      ? [usageDayLabel(d.date), '–', '', '', '']
      : [usageDayLabel(d.date), money(d.cost), String(d.replies), formatTokens(d.inputTokens), formatTokens(d.outputTokens)]
  )
  const dayHead = ['Last 7 days', 'Cost', 'Replies', 'In', 'Out']
  const dayWidths = dayHead.map((h, i) => Math.max(h.length, ...dayRows.map((r) => r[i].length)))
  lines.push(`  ${paint(row(dayHead, dayWidths), 'dim')}`)
  for (const r of dayRows) lines.push(`  ${row(r, dayWidths)}`)

  const top = report.projects.slice(0, TUI_USAGE_PROJECTS)
  if (top.length) {
    lines.push('')
    const projRows = top.map((p) => [
      // A folder name comes off disk: never let it carry an escape sequence.
      stripControlChars(p.name),
      money(p.cost),
      String(p.chats),
      formatTokens(p.inputTokens),
      formatTokens(p.outputTokens)
    ])
    const projHead = ['Top projects, all time', 'Cost', 'Chats', 'In', 'Out']
    const projWidths = projHead.map((h, i) => Math.max(h.length, ...projRows.map((r) => r[i].length)))
    lines.push(`  ${paint(row(projHead, projWidths), 'dim')}`)
    for (const r of projRows) lines.push(`  ${row(r, projWidths)}`)
    const more = report.projects.length - top.length
    if (more > 0) lines.push(paint(`  …and ${more} more project${more === 1 ? '' : 's'}`, 'dim'))
  }

  const week = days.reduce<UsageTotals>(
    (t, d) => ({ cost: t.cost + d.cost, inputTokens: t.inputTokens + d.inputTokens, outputTokens: t.outputTokens + d.outputTokens }),
    { cost: 0, inputTokens: 0, outputTokens: 0 }
  )
  lines.push(
    '',
    `  ${totalsLine('Last 7 days:', week)}`,
    `  ${totalsLine(`Last ${report.days.length} days:`, report.recent)}`,
    `  ${totalsLine('All time:', report.allTime)}, ${report.allTime.chats} chat${report.allTime.chats === 1 ? '' : 's'}`
  )
  if (report.undated.cost > 0 || report.undated.outputTokens > 0) {
    const cost = report.undated.cost > 0 ? `${formatUsd(report.undated.cost)} and ` : ''
    lines.push(
      paint(
        `  ${cost}${formatTokens(report.undated.outputTokens)} output tokens came from subagents, reviews, or older chats with no dated reply: counted in projects and all time, not in a day.`,
        'dim'
      )
    )
  }
  return lines.join('\n')
}

/**
 * The rate-limit part of `/usage`: what each provider last reported this session
 * (requests and tokens left, and when its window refills when it said), from the
 * headers of its replies or a throttled retry, whichever is newer. Empty when no
 * provider has reported anything yet.
 */
export function renderRateLimits(states: readonly RateLimitState[], now: number, paint: Painter): string {
  if (!states.length) return ''
  const lines = ['', paint('Rate limits (this session)', 'bold')]
  const width = Math.max(...states.map((s) => stripControlChars(s.providerId).length))
  for (const s of states) {
    lines.push(`  ${stripControlChars(s.providerId).padEnd(width)}  ${rateLimitLine(s, now)}`)
  }
  return lines.join('\n')
}
