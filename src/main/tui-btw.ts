import type { SideChatTurn } from '@shared/agent'
import type { Painter } from './tui'
import { stripControlChars } from './tui-wrap'

/**
 * Bare `/btw` in the terminal: the side chat's latest exchanges (the desktop's side
 * chat panel shows them all), then a prompt for the next question. Pure, so the
 * layout is testable.
 */

/** Exchanges a bare `/btw` reprints, newest last. */
export const BTW_RECENT_TURNS = 3
/** Lines of each reprinted answer; the rest is cut with a count. */
export const BTW_ANSWER_LINES = 6

/** The prompt a bare `/btw` reads the question with. */
export const BTW_QUESTION_PROMPT = 'Side question (Enter to cancel): '

/** One line of text from the side chat, safe for the terminal. */
const clean = (s: string): string => stripControlChars(s.replace(/\s+/g, ' ').trim())

/**
 * The latest `BTW_RECENT_TURNS` exchanges, each as its question and the start of its
 * answer (or how it failed). Empty when the side chat has none yet.
 */
export function renderRecentSideChat(turns: readonly SideChatTurn[], paint: Painter): string {
  if (!turns.length) return ''
  const shown = turns.slice(-BTW_RECENT_TURNS)
  const earlier = turns.length - shown.length
  const lines = [paint(`Side chat${earlier ? ` (latest ${shown.length} of ${turns.length})` : ''}:`, 'bold')]
  for (const t of shown) {
    lines.push(`  ${paint('›', 'cyan')} ${clean(t.question)}`)
    if (t.answer !== undefined) {
      const body = t.answer
        .trim()
        .split('\n')
        .map((l) => stripControlChars(l))
        .filter((l) => l.trim())
      for (const l of body.slice(0, BTW_ANSWER_LINES)) lines.push(`    ${l}`)
      const more = body.length - BTW_ANSWER_LINES
      if (more > 0) lines.push(paint(`    … ${more} more line${more === 1 ? '' : 's'}`, 'dim'))
    } else {
      lines.push(paint(`    (no answer: ${clean(t.error ?? 'stopped')})`, 'dim'))
    }
  }
  return lines.join('\n')
}
