/**
 * `/queue`: the follow-ups waiting for the running turn to end.
 *
 * A message typed mid-run goes to the turn as a steer when it can; one that can't
 * (a `/command`, a message too long to steer, a line queued on purpose with Tab)
 * waits here, and used to show only as a count on the spinner line. This lists the
 * waiting messages, removes one, sends one to the running turn now, or clears them.
 * Pure parsing and rendering; the driver owns the queue itself.
 */
import { stripControlChars } from './tui-wrap'

export type QueueOp =
  | { op: 'list' }
  | { op: 'drop'; index: number }
  | { op: 'send'; index: number }
  | { op: 'clear' }
  | { op: 'usage' }

export const QUEUE_USAGE = '· usage: /queue, /queue drop <n>, /queue send <n>, /queue clear'

/** Parse `/queue`'s argument. Indexes are 1-based, as the list numbers them. */
export function parseQueueArgs(arg: string): QueueOp {
  const words = arg.trim().split(/\s+/).filter(Boolean)
  if (!words.length) return { op: 'list' }
  const verb = words[0].toLowerCase()
  if (words.length === 1 && (verb === 'clear' || verb === 'drop-all')) return { op: 'clear' }
  if (words.length === 2 && /^\d+$/.test(words[1]) && Number(words[1]) >= 1) {
    const index = Number(words[1])
    if (verb === 'drop' || verb === 'rm' || verb === 'remove' || verb === 'delete') return { op: 'drop', index }
    if (verb === 'send' || verb === 'now') return { op: 'send', index }
  }
  return { op: 'usage' }
}

/**
 * The waiting messages, numbered oldest first (the order they go out in). Plain
 * text: the caller paints it. Each line is the user's own, but it is echoed to a
 * terminal, so control characters are stripped.
 */
export function renderQueueList(items: readonly string[]): string[] {
  if (!items.length) return ['Nothing is queued.']
  const lines = [`Queued for after this turn (${items.length}):`]
  items.forEach((t, i) => {
    const one = stripControlChars(t.replace(/\s+/g, ' ')).trim()
    lines.push(`  ${i + 1}. ${one.length > 200 ? `${one.slice(0, 199)}…` : one}`)
  })
  lines.push('Up edits the newest, /queue drop <n> removes one, /queue send <n> sends one to the turn now.')
  return lines
}
