import { highlightCode, languageForPath } from './highlight'

/**
 * Syntax colour for diff lines, from the same highlighter the code blocks and the
 * Files preview use. Each line is highlighted on its own (a diff shows fragments, so
 * there is no whole file to parse), and the result is turned into plain runs of
 * text and token classes so the diff can still mark the changed words inside a
 * line. Rendering runs as React text keeps the page free of injected HTML.
 */

/** A stretch of a line's text with the highlighter's classes (empty: plain). */
export interface StyledRun {
  text: string
  cls: string
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#x27': "'", '#39': "'" }

function decode(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#x27|#39);/g, (_, e: string) => ENTITIES[e])
}

/**
 * Parse the highlighter's output (only `<span class="…">`, `</span>` and escaped
 * text) into runs. Anything else is kept as text, so a surprise never drops content.
 */
export function hljsRuns(html: string): StyledRun[] {
  const runs: StyledRun[] = []
  const stack: string[] = []
  const re = /<span class="([^"]*)">|<\/span>|([^<]+)|(<)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    if (m[1] !== undefined) stack.push(m[1])
    else if (m[0] === '</span>') stack.pop()
    else {
      const text = m[2] !== undefined ? decode(m[2]) : '<'
      const cls = stack.join(' ')
      const last = runs[runs.length - 1]
      if (last && last.cls === cls) last.text += text
      else runs.push({ text, cls })
    }
  }
  return runs
}

/** The highlighter's language for a diff's file, or null to leave it plain. */
export function diffLanguage(path: string | undefined): string | null {
  return path ? languageForPath(path) : null
}

/** One line's runs, or null when it can't be highlighted. */
export function highlightLine(lang: string | null, text: string): StyledRun[] | null {
  if (!lang || !text) return null
  const html = highlightCode(lang, text)
  if (html === null) return null
  const runs = hljsRuns(html)
  // Never show a line that doesn't round-trip: plain text beats wrong text.
  return runs.map((r) => r.text).join('') === text ? runs : null
}

/** A run with whether it falls inside a changed word. */
export interface MarkedRun extends StyledRun {
  marked: boolean
}

/**
 * Split styled runs where the word marks start and end, so a changed word keeps its
 * syntax colour and gets the changed-word highlight too. `tokens` and `mark` are the
 * line's tokens and which of them changed (see `tokenize` / `wordDiff`).
 */
export function markRuns(runs: StyledRun[], tokens: string[], mark: boolean[] | undefined): MarkedRun[] {
  if (!mark) return runs.map((r) => ({ ...r, marked: false }))
  // Character ranges of the marked tokens.
  const ranges: [number, number][] = []
  let pos = 0
  tokens.forEach((t, i) => {
    if (mark[i]) ranges.push([pos, pos + t.length])
    pos += t.length
  })
  const out: MarkedRun[] = []
  let at = 0
  for (const r of runs) {
    let start = 0
    while (start < r.text.length) {
      const abs = at + start
      const inside = ranges.find(([a, b]) => abs >= a && abs < b)
      // The next boundary after `abs`: the end of the range we're in, or the start of the next.
      const next = inside ? inside[1] : Math.min(...ranges.map(([a]) => a).filter((a) => a > abs), Infinity)
      const end = Math.min(r.text.length, next - at)
      out.push({ text: r.text.slice(start, end), cls: r.cls, marked: Boolean(inside) })
      start = end
    }
    at += r.text.length
  }
  return out
}
