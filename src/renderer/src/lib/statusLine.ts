import type { DisplayItem } from './items'

/**
 * Live status text for the bottom status bar — what the agent is doing right now,
 * derived from the transcript and run state. Pure so it's testable.
 */
export function statusText(items: DisplayItem[], running: boolean): string {
  if (!running) return 'Ready'
  const last = items[items.length - 1]
  if (last?.kind === 'tool') {
    if (last.status === 'awaiting-approval') return `Awaiting approval — ${last.name}`
    if (last.status === 'running') return `Running ${last.name}`
  }
  if (last?.kind === 'assistant' && last.streaming) return 'Responding…'
  return 'Working…'
}
