import { useMemo } from 'react'
import { numberDiff, replacementPairs, tokenize, wordDiff, type DiffLine, type NumberedLine } from '@shared/diff'
import { diffLanguage, highlightLine, markRuns } from '../lib/diffHighlight'

/** Cap how many diff lines render at once so a huge change can't lock the UI. */
export const MAX_DIFF_LINES = 300

/**
 * Render a line diff as a red/green `<pre>`. Shared by the tool-call cards
 * (edit_file / write_file) and the Changes panel (per-hunk).
 *
 * The numbering and the word marks come from `@shared/diff`, which is where the
 * terminal's diff gets them too — the approval card is the moment someone decides
 * whether to let a change happen, and the two clients must not disagree about what
 * the change IS.
 */

/**
 * One line's text, with the tokens that actually changed wrapped for emphasis and,
 * when the file's language is known, syntax colour.
 */
function LineText({ text, mark, lang }: { text: string; mark?: boolean[]; lang: string | null }): JSX.Element {
  const runs = highlightLine(lang, text)
  if (runs) {
    return (
      <span className="diff__text">
        {markRuns(runs, mark ? tokenize(text) : [], mark).map((r, i) => {
          const piece = r.cls ? (
            <span key={i} className={r.cls}>
              {r.text}
            </span>
          ) : (
            <span key={i}>{r.text}</span>
          )
          return r.marked ? (
            <mark key={i} className="diff__word">
              {piece}
            </mark>
          ) : (
            piece
          )
        })}
      </span>
    )
  }
  if (!mark) return <span className="diff__text">{text || ' '}</span>
  return (
    <span className="diff__text">
      {tokenize(text).map((t, i) =>
        mark[i] ? (
          <mark key={i} className="diff__word">
            {t}
          </mark>
        ) : (
          <span key={i}>{t}</span>
        )
      )}
    </span>
  )
}

function sign(type: NumberedLine['type']): string {
  return type === 'add' ? '+' : type === 'del' ? '−' : ' '
}

/** Unified (one column) or side by side (old on the left, new on the right). */
export type DiffLayout = 'unified' | 'split'

/** A row of the side-by-side view: the old line on the left, the new on the right. */
interface SplitRow {
  left?: number
  right?: number
  /** A folded run of unchanged lines, spanning both sides. */
  skip?: number
}

/** Pair a diff's lines into side-by-side rows: context on both sides, each run of
 *  removed lines beside the added lines that follow it. Indexes into `lines`. */
export function splitRows(lines: NumberedLine[]): SplitRow[] {
  const rows: SplitRow[] = []
  let i = 0
  while (i < lines.length) {
    const l = lines[i]
    if (l.type === 'skip') {
      rows.push({ skip: i })
      i++
    } else if (l.type === 'ctx') {
      rows.push({ left: i, right: i })
      i++
    } else {
      const dels: number[] = []
      const adds: number[] = []
      while (i < lines.length && lines[i].type === 'del') dels.push(i++)
      while (i < lines.length && lines[i].type === 'add') adds.push(i++)
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ left: dels[k], right: adds[k] })
    }
  }
  return rows
}

export function DiffView({
  diff,
  path,
  start,
  layout = 'unified'
}: {
  diff: DiffLine[]
  /** The file's path, to pick a syntax-highlighting language from its extension. */
  path?: string
  /** The first old and new line numbers (a hunk's position in its file); default 1. */
  start?: { old: number; new: number }
  layout?: DiffLayout
}): JSX.Element {
  const lines = useMemo(() => {
    const numbered = numberDiff(diff)
    if (!start) return numbered
    return numbered.map((l) => ({
      ...l,
      ...(l.oldNo !== undefined ? { oldNo: l.oldNo + start.old - 1 } : {}),
      ...(l.newNo !== undefined ? { newNo: l.newNo + start.new - 1 } : {})
    }))
  }, [diff, start])
  const lang = diffLanguage(path)
  // A del followed by its add is a replacement, so the changed words can be marked
  // inside both. Computed over the whole diff before slicing, so the pairing does
  // not change with where the cap happens to fall.
  const pairs = replacementPairs(lines)
  const partnerOf = new Map<number, number>()
  for (const [del, add] of pairs) partnerOf.set(add, del)

  const marksFor = (i: number, l: NumberedLine): boolean[] | undefined => {
    const addIdx = pairs.get(i)
    if (addIdx !== undefined) return wordDiff(l.text, lines[addIdx].text).del
    const delIdx = partnerOf.get(i)
    if (delIdx !== undefined) return wordDiff(lines[delIdx].text, l.text).add
    return undefined
  }

  // Gutter width from the largest number in the whole diff, so it doesn't jitter.
  const width = Math.max(2, ...lines.map((l) => String(Math.max(l.oldNo ?? 0, l.newNo ?? 0)).length))
  const shown = lines.slice(0, MAX_DIFF_LINES)
  const more =
    lines.length > MAX_DIFF_LINES ? (
      <div className="diff__more">… {lines.length - MAX_DIFF_LINES} more lines</div>
    ) : null

  const skipLine = (l: NumberedLine, key: string | number): JSX.Element => (
    <div key={key} className="diff__line diff__line--skip">
      <span className="diff__no" aria-hidden="true" />
      <span className="diff__sign">⋯</span>
      <span className="diff__text">{l.text}</span>
    </div>
  )

  if (layout === 'split') {
    const half = (i: number | undefined, side: 'old' | 'new'): JSX.Element => {
      if (i === undefined) return <div className="diff__line diff__line--empty" aria-hidden="true" />
      const l = shown[i]
      const type = l.type === 'ctx' ? 'ctx' : side === 'old' ? 'del' : 'add'
      return (
        <div className={`diff__line diff__line--${type}`}>
          <span className="diff__no" aria-hidden="true">
            {side === 'old' ? l.oldNo : l.newNo}
          </span>
          <span className="diff__sign">{sign(type)}</span>
          <LineText text={l.text} mark={marksFor(i, l)} lang={lang} />
        </div>
      )
    }
    return (
      <pre className="diff diff--split" style={{ ['--diff-gutter' as string]: `${width}ch` }}>
        {splitRows(shown).map((r, k) =>
          r.skip !== undefined ? (
            skipLine(shown[r.skip], k)
          ) : (
            <div key={k} className="diff__row">
              {half(r.left, 'old')}
              {half(r.right, 'new')}
            </div>
          )
        )}
        {more}
      </pre>
    )
  }

  return (
    <pre className="diff" style={{ ['--diff-gutter' as string]: `${width}ch` }}>
      {shown.map((l, i) =>
        // A `skip` stands for unchanged lines folded away by hunkDiff; showing it
        // as a normal line would print the count as if it were code.
        l.type === 'skip' ? (
          skipLine(l, i)
        ) : (
          <div key={i} className={`diff__line diff__line--${l.type}`}>
            {/* The number is decoration for a screen reader — the sign already says
                what happened, and reading a line number before every line is noise. */}
            <span className="diff__no" aria-hidden="true">
              {l.type === 'del' ? l.oldNo : l.newNo}
            </span>
            <span className="diff__sign">{sign(l.type)}</span>
            <LineText text={l.text} mark={marksFor(i, l)} lang={lang} />
          </div>
        )
      )}
      {more}
    </pre>
  )
}
