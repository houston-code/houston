import type { ReviewFinding } from '@shared/agent'
import { droppedSummary, findingTally, isDropped, upsertFinding } from '@shared/reviewFindings'
import { turnErrorHelp, type TurnErrorAction, type TurnErrorCause } from '@shared/turnError'
import type { Painter } from './tui'
import { terminalText } from './tui-wrap'

/**
 * How the terminal shows parts of a running turn that the desktop shows in its
 * transcript rows: a failed turn's explanation, which tools get no line, a finished
 * review's tally, images a tool returned, and the models a turn used. Pure, so the
 * driver only decides when to print. Folded tool lines, file reads included, are
 * renderFoldedCalls in tui.ts.
 */

/** The TUI command for each next step the desktop's failed-turn bar offers. */
const ERROR_ACTION_COMMAND: Record<TurnErrorAction, string> = {
  retry: '/retry',
  'provider-settings': '/login',
  doctor: '/doctor',
  'switch-model': '/model'
}

/**
 * A failed turn: the provider's own message, then the same plain-words explanation
 * and hint the desktop's failed-turn bar shows, and the commands for its next steps.
 */
export function renderTurnError(message: string, cause: TurnErrorCause | undefined, paint: Painter): string {
  const help = turnErrorHelp(cause, message)
  // Retry always stays on offer, last when the cause suggests something better first.
  const actions = help.actions.includes('retry') ? help.actions : [...help.actions, 'retry' as const]
  const next = actions.map((a) => ERROR_ACTION_COMMAND[a]).join(', ')
  return [
    paint(`Error: ${terminalText(message)}`, 'red'),
    paint(`  ${help.summary} ${help.hint}`, 'yellow'),
    paint(`  next: ${next}`, 'dim')
  ].join('\n')
}

/** "· 2 images returned (not shown in the terminal)", or null for none. */
export function toolImagesLine(count: number, paint: Painter): string | null {
  if (count <= 0) return null
  return paint(`  ↳ ${count} image${count === 1 ? '' : 's'} returned (not shown in the terminal)`, 'dim')
}

/**
 * A review's findings as they arrive, so its result line can end with the same
 * severity tally the desktop's review row shows once the review is done.
 */
export class ReviewTally {
  private readonly byCall = new Map<string, ReviewFinding[]>()

  add(parentCallId: string, f: ReviewFinding): void {
    this.byCall.set(parentCallId, upsertFinding(this.byCall.get(parentCallId) ?? [], f))
  }

  /** The finished review's tally line (and forgets the call), or null with no findings. */
  take(callId: string, paint: Painter): string | null {
    const list = this.byCall.get(callId)
    this.byCall.delete(callId)
    if (!list?.length) return null
    const tally = findingTally(list)
    if (!tally) return null
    const dropped = droppedSummary(list)
    const alarm = list.some((f) => !isDropped(f) && (f.severity === 'critical' || f.severity === 'high'))
    return paint(`  ↳ review: ${tally}${dropped ? ` (${dropped})` : ''}`, alarm ? 'yellow' : 'dim')
  }
}

/** The models a turn's rounds were billed to, in first-use order: "a", "a, b". */
export function turnModelsLabel(models: readonly string[]): string {
  return [...new Set(models.filter((m) => m.trim()))].map((m) => terminalText(m, { lines: false })).join(', ')
}

/** Tools the desktop never gives a row of their own: navigation noise. */
const HIDDEN_TOOLS = new Set(['list_dir'])

/**
 * Whether a tool's lines are left out of the transcript, as the desktop drops its
 * row (`groupItems` in the renderer's toolDisplay.ts). An approval prompt for one is
 * still printed, since that prompt is what the run waits on; /verbose shows them all.
 */
export function isHiddenTool(name: string, verbose: boolean): boolean {
  return !verbose && HIDDEN_TOOLS.has(name)
}
