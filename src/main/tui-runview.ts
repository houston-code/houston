import type { ReviewFinding } from '@shared/agent'
import { droppedSummary, findingTally, isDropped, upsertFinding } from '@shared/reviewFindings'
import { describeToolCall } from '@shared/toolLabel'
import { turnErrorHelp, type TurnErrorAction, type TurnErrorCause } from '@shared/turnError'
import type { Painter } from './tui'
import { terminalText, truncateVisible } from './tui-wrap'

/**
 * How the terminal shows parts of a running turn that the desktop shows in its
 * transcript rows: a failed turn's explanation, folded file reads, a finished
 * review's tally, images a tool returned, and the models a turn used. Pure (or, for
 * the read fold, self-contained state), so the driver only decides when to print.
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

interface PendingRead {
  callId: string
  args: Record<string, unknown>
  /** The result's output once it has landed (successfully). */
  output?: string
}

/**
 * Consecutive `read_file` calls, held back so a burst of reads prints as one line
 * ("· Read 3 files  a.ts, b.ts, c.ts") the way the desktop folds them into one row
 * (`foldReadRuns`). Line mode can't rewrite a line already printed, so the reads
 * are printed when something else happens; a lone read prints exactly as before.
 */
export class ReadFold {
  private pending: PendingRead[] = []

  constructor(
    private readonly render: {
      /** One read, as an ordinary tool start line plus its result line (if it has one). */
      single: (args: Record<string, unknown>, output: string | undefined) => string
      /** The fold line for several reads. */
      many: (targets: string[]) => string
    }
  ) {}

  /** Hold a read back. */
  start(callId: string, args: Record<string, unknown>): void {
    this.pending.push({ callId, args })
  }

  /** Whether a call is a read being held back. */
  holds(callId: string): boolean {
    return this.pending.some((p) => p.callId === callId)
  }

  /** A held read finished successfully: keep its output for a lone read's result line. */
  finish(callId: string, output: string): void {
    const p = this.pending.find((x) => x.callId === callId)
    if (p) p.output = output
  }

  /**
   * The held reads as text to print (no trailing newline), or '' when none are held.
   * A read whose result hasn't landed yet prints its start line alone; its result
   * then prints the ordinary way.
   */
  flush(): string {
    const reads = this.pending
    this.pending = []
    if (reads.length === 0) return ''
    const done = reads.filter((r) => r.output !== undefined)
    const open = reads.filter((r) => r.output === undefined)
    const parts: string[] = []
    if (done.length >= 2) parts.push(this.render.many(done.map((r) => describeToolCall('read_file', r.args).target)))
    else if (done.length === 1) parts.push(this.render.single(done[0].args, done[0].output))
    for (const r of open) parts.push(this.render.single(r.args, undefined))
    return parts.filter(Boolean).join('\n')
  }
}

/** The fold line's list of files, cut to fit the terminal. */
export function readFoldLine(
  targets: string[],
  paint: Painter,
  opts: { width: number; sentence?: boolean }
): string {
  const files = targets.map((t) => terminalText(t, { lines: false }).replace(/\s+/g, ' ').trim()).filter(Boolean)
  const count = `${targets.length} files`
  const list = files.join(', ')
  if (opts.sentence) return `Using tool Read: ${count}${list ? `: ${list}` : ''}`
  const head = `${paint('·', 'dim')} ${paint('Read', 'cyan')} ${count}`
  // "· Read 3 files  " is about 16 columns; the list gets the rest of the row.
  const room = Math.max(20, opts.width - count.length - 10)
  return list ? `${head}  ${paint(truncateVisible(list, room), 'dim')}` : head
}
