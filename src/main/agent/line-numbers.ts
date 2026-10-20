/**
 * The line-number format `read_file` shows text in, and its inverse.
 *
 * Each line is prefixed with its 1-based number, right-aligned to the width of the
 * file's last line number, then a tab: `  9\tfoo`, ` 10\tbar`. The width comes from
 * the whole file rather than the slice shown, so every read of one file lines up the
 * same way. Edit feedback (fuzzy-match snippets, the closest region to a missed
 * `old_string`) uses the same format, so a number the model sees anywhere means the
 * same line.
 *
 * A model that copies those lines into `old_string` / `new_string` sometimes copies
 * the prefixes too; {@link stripLineNumbers} recognizes that case so the edit can
 * still land.
 */

/** One line of a numbered listing: `lineNo` right-aligned to `width`, then a tab. */
export function numberedLine(lineNo: number, width: number, text: string): string {
  return `${String(lineNo).padStart(width)}\t${text}`
}

/** Digits in the largest line number of a `totalLines`-line file (at least 1). */
export function numberWidth(totalLines: number): number {
  return String(Math.max(1, totalLines)).length
}

/**
 * A file's lines as `read_file` counts them: split on `\n`, with the empty segment
 * after a final newline dropped, so `"a\nb\n"` is two lines (as `wc -l` and an editor
 * count it), not three. A `\r` before the `\n` stays on its line. Empty text has no
 * lines.
 */
export function displayLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * `lines[from-1 .. to-1]` as a numbered listing, using `width` for every number.
 * `from` and `to` are 1-based and inclusive.
 */
export function numberLines(lines: string[], from: number, to: number, width: number): string {
  const out: string[] = []
  for (let n = from; n <= to; n++) out.push(numberedLine(n, width, lines[n - 1] ?? ''))
  return out.join('\n')
}

/** A copied prefix: optional padding, the number, then the tab (or end of line). */
const PREFIX = /^ *(\d+)(\t|$)/

/**
 * `text` with a copied line-number prefix removed from every line, or `null` when
 * not every line carries one (then the text is real content and stays as written).
 *
 * A trailing newline is kept and not counted as a line. A line that is just a
 * number counts as prefixed only if some other line has the tab: the model trims
 * the trailing tab off a numbered blank line, but a lone number without any tab is
 * ordinary content. With `consecutive`, the numbers must also run n, n+1, n+2, ...,
 * as they do in text copied straight out of a listing; that is how `old_string` is
 * checked. `new_string` is checked without it, because the model may have deleted
 * or added lines in its copy.
 *
 * This only decides whether the text looks copied. Callers strip only after the
 * text as written failed to match, so content that merely looks numbered (a
 * tab-separated table whose first column counts up) is never altered when it is
 * really there.
 */
export function stripLineNumbers(text: string, opts: { consecutive?: boolean } = {}): string | null {
  if (text === '') return null
  const trailingNewline = text.endsWith('\n')
  const lines = (trailingNewline ? text.slice(0, -1) : text).split('\n')
  const stripped: string[] = []
  let sawTab = false
  let prev: number | null = null
  for (const line of lines) {
    const m = PREFIX.exec(line)
    if (!m) return null
    const n = Number(m[1])
    if (opts.consecutive && prev !== null && n !== prev + 1) return null
    prev = n
    if (m[2] === '\t') sawTab = true
    stripped.push(line.slice(m[0].length))
  }
  if (!sawTab) return null
  return stripped.join('\n') + (trailingNewline ? '\n' : '')
}
