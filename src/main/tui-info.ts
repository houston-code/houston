import type { SubagentSpend } from '@shared/subagents'
import { formatTokens, formatUsd } from '@shared/usage'
import type { Painter } from './tui'
import { stripControlChars, terminalText } from './tui-wrap'

/**
 * Small terminal reports that mirror a desktop surface: the subagent rows of the
 * cost breakdown (`/cost`), Help > Report an Issue (`/bug`), and the "What's new"
 * note after an upgrade. Pure: the driver supplies the facts.
 */

/** Subagent rows `/cost` lists before the rest are summed into one, as the desktop does. */
export const MAX_AGENT_ROWS = 8

/**
 * The cost breakdown's "Subagents (included above)" rows: what each subagent in the
 * chat spent, most expensive first. Their tokens are already in the per-model rows,
 * so this says which agent spent them rather than adding to the total. Empty when
 * no subagent has reported its spend.
 */
export function renderSubagentSpend(agents: SubagentSpend[], paint: Painter): string {
  if (!agents.length) return ''
  const shown = agents.slice(0, MAX_AGENT_ROWS)
  const rest = agents.slice(MAX_AGENT_ROWS)
  const label = (a: SubagentSpend): string => terminalText(stripControlChars(a.label), { lines: false })
  const rows = shown.map((a) => ({ name: label(a), model: terminalText(a.model, { lines: false }), input: a.input, output: a.output, cost: a.costUsd }))
  if (rest.length) {
    rows.push({
      name: `${rest.length} more subagent${rest.length === 1 ? '' : 's'}`,
      model: '',
      input: rest.reduce((n, a) => n + a.input, 0),
      output: rest.reduce((n, a) => n + a.output, 0),
      cost: rest.reduce((n, a) => n + a.costUsd, 0)
    })
  }
  const width = Math.min(40, Math.max(...rows.map((r) => r.name.length)))
  const fit = (s: string): string => (s.length > width ? `${s.slice(0, width - 1)}…` : s.padEnd(width))
  const lines = [paint('  Subagents (included above):', 'dim')]
  for (const r of rows) {
    const model = r.model ? paint(`  ${r.model}`, 'dim') : ''
    lines.push(`    ${fit(r.name)}  ${formatTokens(r.input)}+${formatTokens(r.output)} tok  ${r.cost > 0 ? formatUsd(r.cost) : '–'}${model}`)
  }
  return lines.join('\n')
}

/**
 * Where the log file is, for `/feedback` (also `/bug`): shown on screen to attach if it
 * helps, never put in the report itself.
 */
export function renderLogFileLine(logPath: string | null, paint: Painter): string {
  return logPath
    ? `${paint('Log file:', 'dim')} ${terminalText(logPath, { lines: false })}${paint(' (read it before attaching: it can name your folders)', 'dim')}`
    : paint('The log file could not be found.', 'dim')
}

/** The one-time note after an upgrade: the release's one-sentence summary. */
export function renderWhatsNew(info: { version: string; highlights: string }, paint: Painter): string {
  const text = terminalText(info.highlights, { lines: false })
  return `${paint(`What's new in Houston ${terminalText(info.version, { lines: false })}:`, 'bold')} ${text}`
}
