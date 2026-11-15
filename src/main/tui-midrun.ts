/**
 * What the user types while a turn runs, and what is waiting on it, as the terminal
 * shows them: the draft on the activity (spinner) line and one row per waiting
 * message under it. Pure, so the layout is unit-tested without a terminal; the
 * streaming watcher in tui-io.ts owns the keys and the redraw.
 */
import type { Painter } from './tui'
import { truncateVisible, stripControlChars } from './tui-wrap'

/** A message typed mid-run that has not reached the model yet. */
export interface WaitingInput {
  /** Matches the id the live run holds a steer under, so it can be taken back. */
  id: string
  text: string
  /** `steer`: waiting to land in the running turn. `queued`: sent after it ends. */
  kind: 'steer' | 'queued'
}

/** Rows of waiting messages shown before the rest collapse to a count. */
export const MAX_WAITING_ROWS = 4

/** The mark a line break in the draft shows as on the one-line activity row. */
export const DRAFT_BREAK = ' ↵ '

/** The key hints under the draft, said once a line is being typed mid-run. */
export const MIDRUN_TYPING_HINT = 'Enter steers · Tab queues for after the turn · Alt-Enter new line'
/** The hint under the waiting rows. */
export const MIDRUN_TAKE_BACK_HINT = 'Up on an empty line takes the last one back to edit'

/** One line of text, its line breaks shown as {@link DRAFT_BREAK}. */
export function oneLine(text: string): string {
  return text
    .split('\n')
    .map((l) => stripControlChars(l))
    .join(DRAFT_BREAK)
}

/**
 * The rows under the activity line: each waiting message (oldest first, the newest
 * at the bottom, next to the hint that takes it back), and a key hint. Every row
 * fits in `width` columns, since a wrapped row would desync the in-place redraw.
 */
export function midRunRows(
  waiting: readonly WaitingInput[],
  opts: { width: number; paint: Painter; typing: boolean }
): string[] {
  const { width, paint } = opts
  const fit = (s: string): string => truncateVisible(s, Math.max(1, width))
  const rows: string[] = []
  const hidden = waiting.length - MAX_WAITING_ROWS
  if (hidden > 0) rows.push(fit(paint(`  … ${hidden} earlier waiting`, 'dim')))
  for (const w of waiting.slice(Math.max(0, hidden))) {
    const tag = w.kind === 'steer' ? paint('steering next:', 'cyan') : paint('queued:', 'dim')
    rows.push(fit(`  ${paint('↳', 'dim')} ${tag} ${oneLine(w.text)}`))
  }
  if (waiting.length && !opts.typing) rows.push(fit(paint(`  ${MIDRUN_TAKE_BACK_HINT}`, 'dim')))
  if (opts.typing) rows.push(fit(paint(`  ${MIDRUN_TYPING_HINT}`, 'dim')))
  return rows
}

/** What a screen reader hears when a message joins the waiting list. */
export function waitingAnnouncement(item: WaitingInput, count: number): string {
  return item.kind === 'steer'
    ? 'sent to the running turn'
    : `queued for after this turn (${count} waiting)`
}
