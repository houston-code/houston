import { stripControlChars, truncateVisible } from './tui-wrap'
import type { Painter } from './tui'

/**
 * The key-shortcut overlay: `?` on an empty prompt shows the Keys section of /help
 * (and the user's own keybindings) under the composer until the next key.
 */

/**
 * The `Keys:` section of a help text, without its heading: every line after
 * `Keys:` up to the first blank one. The overlay reads it from /help so the two can
 * never disagree.
 */
export function keysSection(help: string): string[] {
  const lines = help.split('\n')
  const start = lines.indexOf('Keys:')
  if (start < 0) return []
  const out: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) break
    out.push(line)
  }
  return out
}

/** The overlay's content: the keys, then any user bindings. */
export function shortcutLines(keys: string[], userBindings: string[]): string[] {
  const out = ['Keys:', ...keys]
  if (userBindings.length) out.push('', 'Your keybindings (~/.houston/keybindings.json):', ...userBindings)
  return out
}

const OVERLAY_HINT = 'any key closes this · /help for commands'

/**
 * The overlay as rows drawn under the composer. Each row fits the width (a wrapped
 * row would desync the composer's redraw region), and there are never more than
 * the terminal leaves room for: what does not fit is counted, with /help named for
 * the rest.
 */
export function shortcutOverlayRows(
  lines: string[],
  opts: { width: number; rows: number; paint: Painter }
): string[] {
  const width = Math.max(8, opts.width)
  // The prompt row, the hint and a row of slack for the cursor.
  const room = Math.max(1, opts.rows - 3)
  const clean = lines.map((l) => truncateVisible(stripControlChars(l), width))
  let body = clean
  if (clean.length > room) {
    const keep = Math.max(0, room - 1)
    body = [...clean.slice(0, keep), truncateVisible(`… ${clean.length - keep} more in /help`, width)]
  }
  return [...body.map((l) => (l.endsWith(':') && !l.startsWith(' ') ? opts.paint(l, 'bold') : l)), opts.paint(truncateVisible(OVERLAY_HINT, width), 'dim')]
}

/** The overlay for screen-reader mode: plain lines, all of them, and no hint about closing. */
export function shortcutPlainLines(lines: string[]): string[] {
  return [...lines.map((l) => stripControlChars(l)), 'end of keys']
}
