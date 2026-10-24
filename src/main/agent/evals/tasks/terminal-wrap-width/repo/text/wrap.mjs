import { stripAnsi } from './ansi.mjs'

/**
 * Wrap text to lines at most `width` columns wide (width.mjs says what a column is).
 *
 * Lines break at spaces where they can. A word wider than a whole line is broken
 * between characters, never inside one, so a flag or 👩‍💻 is never cut in half. Color
 * codes take no columns and are never cut either. Wrapped lines carry no leading or
 * trailing spaces, and newlines in the text are kept as line breaks.
 */
export function wrap(text, width) {
  const out = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const word of paragraph.split(' ').filter(Boolean)) {
      let rest = word
      while (stripAnsi(rest).length > width) {
        if (line) {
          out.push(line)
          line = ''
        }
        out.push(rest.slice(0, width))
        rest = rest.slice(width)
      }
      const candidate = line ? `${line} ${rest}` : rest
      if (stripAnsi(candidate).length > width) {
        out.push(line)
        line = rest
      } else {
        line = candidate
      }
    }
    out.push(line)
  }
  return out
}
