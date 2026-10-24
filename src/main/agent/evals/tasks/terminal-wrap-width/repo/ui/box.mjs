import { stringWidth } from '../text/width.mjs'
import { wrap } from '../text/wrap.mjs'

/** A titled box `width` columns wide, its body wrapped to fit inside the border. */
export function box(title, body, width) {
  const inner = width - 4
  const top = `┌─ ${title} ${'─'.repeat(Math.max(0, width - stringWidth(title) - 5))}┐`
  const rows = wrap(body, inner).map((l) => `│ ${l}${' '.repeat(Math.max(0, inner - stringWidth(l)))} │`)
  return [top, ...rows, `└${'─'.repeat(width - 2)}┘`].join('\n')
}
