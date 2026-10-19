import type { DisplayItem } from './items'

/**
 * What the run is blocked on, if it is waiting for the user: an approval card, an
 * unanswered question, a plan awaiting review, or an MCP server's input form. Only
 * the current turn (everything after the last user message) is considered, and the
 * prompt need not be the last row: a parallel batch of tool calls can leave the
 * approval card above rows that arrived after it.
 */
function waitingOn(items: DisplayItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it.kind === 'user') break
    if (it.kind === 'tool' && it.status === 'awaiting-approval') return `Waiting for your approval: ${it.name}`
    if (it.kind === 'question' && it.answer === undefined) return 'Waiting for your answer'
    if (it.kind === 'plan' && it.status === 'pending') return 'Waiting for you to review the plan'
    if (it.kind === 'elicitation' && !it.outcome) return 'Waiting for your input'
  }
  return null
}

/**
 * Live status text for the bottom status bar: what the agent is doing right now,
 * derived from the transcript and run state. Pure so it's testable.
 */
export function statusText(items: DisplayItem[], running: boolean): string {
  if (!running) return 'Ready'
  const waiting = waitingOn(items)
  if (waiting) return waiting
  const last = items[items.length - 1]
  if (last?.kind === 'tool' && last.status === 'running') return `Running ${last.name}`
  if (last?.kind === 'assistant' && last.streaming) return 'Responding…'
  return 'Working…'
}
