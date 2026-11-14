import type { RenderNode } from './toolDisplay'
import { parseAt } from './messageMeta'

/**
 * What the transcript tells a screen reader that sighted users get from the layout:
 * the heading each message carries, and the line the polite live region speaks when
 * the conversation's last row changes.
 */

/** Longest reply text read out; past it the announcement stops with an ellipsis. */
export const MAX_SPOKEN_CHARS = 1000

/** The clock time a message was written, for its heading ("3:42 PM"). */
function clock(at: string | undefined): string | undefined {
  const t = parseAt(at)
  return t === undefined ? undefined : new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/**
 * A message's visually hidden heading, so a screen reader can jump message to message
 * and hear who wrote each: "You", or "Houston, 3:42 PM".
 */
export function messageHeading(role: 'user' | 'assistant', at: string | undefined): string {
  if (role === 'user') return 'You'
  const time = clock(at)
  return time ? `Houston, ${time}` : 'Houston'
}

/**
 * A reply's markdown as it should sound: code fences, emphasis marks, heading and list
 * markers, and link targets dropped, whitespace folded, and capped in length.
 */
export function spokenText(markdown: string): string {
  const plain = markdown
    .replace(/```[^\n]*\n?/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/(\*\*|__|\*|_|~~|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > MAX_SPOKEN_CHARS ? `${plain.slice(0, MAX_SPOKEN_CHARS).trimEnd()}…` : plain
}

/**
 * The polite live region's text for the transcript's last row. By default only coarse
 * states (responding, response ready, waiting on you). With `announceReplies`, a
 * finished reply is read out in full and a tool that failed is named.
 */
export function liveAnnouncement(last: RenderNode | undefined, announceReplies: boolean): string {
  if (!last) return ''
  if (last.kind === 'toolgroup') {
    if (last.items.some((i) => i.status === 'awaiting-approval')) return 'The agent is waiting for your approval.'
    if (announceReplies) {
      const failed = [...new Set(last.items.filter((i) => i.status === 'error').map((i) => i.name))]
      if (failed.length) return `${failed.join(', ')} failed.`
    }
    return ''
  }
  if (last.kind === 'question') return 'The agent is asking a question.'
  if (last.kind === 'elicitation' && !last.item.outcome) return 'An MCP server is requesting input.'
  if (last.kind === 'assistant') {
    if (last.item.streaming) return 'The agent is responding…'
    const text = announceReplies ? spokenText(last.item.text) : ''
    return text ? `Houston replied: ${text}` : 'Response ready.'
  }
  return ''
}
