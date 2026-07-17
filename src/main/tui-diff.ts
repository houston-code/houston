import { numberDiff, tokenize, wordDiff, type DiffLine, type FileDiffPreview } from '@shared/diff'
import type { Painter } from './tui'

// Re-exported so this module stays the terminal's diff surface, while the pure
// parts (numbering, word marks) live in shared and are rendered by the GUI too —
// one implementation, so the two clients cannot disagree about what changed.
export { numberDiff, wordDiff, type NumberedLine } from '@shared/diff'

/**
 * The diff you read before approving an edit.
 *
 * The terminal rendered it as flat `+`/`-` text: no line numbers, so "where is
 * this?" meant opening the file; and a one-word change on a long line showed as a
 * whole red line and a whole green one, leaving you to spot the difference by eye.
 * That is the wrong place to make someone squint — it is the moment they are
 * deciding whether to let the change happen.
 *
 * This adds what a reviewable diff needs: a numbered gutter, the changed WORDS
 * marked inside a modified line, and (when a highlighter is wired) the code
 * syntax-coloured. The hunking itself happens upstream in `hunkDiff`, so what
 * arrives here is already the change rather than the file.
 *
 * Pure, so what gets shown is unit-testable.
 */

/** Paint a line, emphasizing only the tokens that changed. */
function paintWords(text: string, mark: boolean[], paint: Painter, tone: 'red' | 'green'): string {
  return tokenize(text)
    .map((t, i) => (mark[i] ? paint(t, tone, 'bold') : paint(t, tone)))
    .join('')
}

export interface DiffViewOptions {
  /** Syntax highlighter for a line of code, from the entry point. */
  highlight?: (code: string) => string
  /** Cap on rendered lines, so a huge rewrite can't bury the prompt. */
  maxLines?: number
}

/** Enough to review a real edit, short of burying the prompt under it. */
export const MAX_DIFF_LINES = 60

/** Render one file's hunked diff with a numbered gutter and word marks. */
export function renderDiffLines(diff: DiffLine[], paint: Painter, opts: DiffViewOptions = {}): string[] {
  const lines = numberDiff(diff)
  const max = opts.maxLines ?? MAX_DIFF_LINES
  // Gutter width from the largest number actually shown.
  const width = Math.max(2, ...lines.map((l) => String(Math.max(l.oldNo ?? 0, l.newNo ?? 0)).length))
  const out: string[] = []
  let shown = 0
  let clipped = 0

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (shown >= max && l.type !== 'skip') {
      clipped++
      continue
    }
    if (l.type === 'skip') {
      out.push(`  ${paint('·'.repeat(width), 'dim')} ${paint(`⋯ ${l.text}`, 'dim')}`)
      continue
    }
    if (l.type === 'ctx') {
      const gutter = paint(String(l.oldNo ?? '').padStart(width), 'dim')
      out.push(`  ${gutter} ${paint('│', 'dim')} ${opts.highlight ? opts.highlight(l.text) : paint(l.text, 'dim')}`)
      shown++
      continue
    }
    // A del immediately followed by an add is a REPLACEMENT: mark what changed
    // inside it rather than painting both lines solid.
    const next = lines[i + 1]
    if (l.type === 'del' && next?.type === 'add') {
      const { del, add } = wordDiff(l.text, next.text)
      out.push(
        `  ${paint(String(l.oldNo ?? '').padStart(width), 'dim')} ${paint('-', 'red')} ${paintWords(l.text, del, paint, 'red')}`
      )
      out.push(
        `  ${paint(String(next.newNo ?? '').padStart(width), 'dim')} ${paint('+', 'green')} ${paintWords(next.text, add, paint, 'green')}`
      )
      shown += 2
      i++ // consumed the partner
      continue
    }
    const tone = l.type === 'del' ? 'red' : 'green'
    const no = l.type === 'del' ? l.oldNo : l.newNo
    out.push(`  ${paint(String(no ?? '').padStart(width), 'dim')} ${paint(l.type === 'del' ? '-' : '+', tone)} ${paint(l.text, tone)}`)
    shown++
  }
  if (clipped > 0) out.push(`  ${paint(`… ${clipped} more changed lines`, 'dim')}`)
  return out
}

/**
 * Render every file a write would touch. `highlight` takes the file's extension,
 * so the code inside the diff is coloured the way the same code is in a fenced
 * block elsewhere in the transcript.
 */
export function renderPreviewView(
  preview: FileDiffPreview[],
  paint: Painter,
  highlight?: (lang: string, code: string) => string
): string | null {
  if (!preview.length) return null
  return preview
    .map((f) => {
      const tag = f.created
        ? paint(' (new file)', 'dim')
        : f.deleted
          ? paint(' (deleted)', 'dim')
          : f.renamedFrom
            ? paint(` (renamed from ${f.renamedFrom})`, 'dim')
            : ''
      const lang = f.path.slice(f.path.lastIndexOf('.') + 1)
      const hl = highlight && lang ? (code: string) => highlight(lang, code) : undefined
      const head = `  ${paint(f.path, 'cyan', 'bold')}${tag}`
      const body = renderDiffLines(f.diff, paint, hl ? { highlight: hl } : {})
      // `truncated` now means the CHANGE itself is enormous (the file's untouched
      // parts were folded away upstream), which is worth saying plainly.
      const more = f.truncated ? [paint('  … this change is too large to show in full', 'dim')] : []
      return [head, ...body, ...more].join('\n')
    })
    .join('\n')
}
