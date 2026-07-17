import { numberDiff, replacementPairs, tokenize, wordDiff, type DiffLine, type NumberedLine } from '@shared/diff'

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

/** One line's text, with the tokens that actually changed wrapped for emphasis. */
function LineText({ text, mark }: { text: string; mark?: boolean[] }): JSX.Element {
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

export function DiffView({ diff }: { diff: DiffLine[] }): JSX.Element {
  const lines = numberDiff(diff)
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

  return (
    <pre className="diff" style={{ ['--diff-gutter' as string]: `${width}ch` }}>
      {lines.slice(0, MAX_DIFF_LINES).map((l, i) =>
        // A `skip` stands for unchanged lines folded away by hunkDiff; showing it
        // as a normal line would print the count as if it were code.
        l.type === 'skip' ? (
          <div key={i} className="diff__line diff__line--skip">
            <span className="diff__no" aria-hidden="true" />
            <span className="diff__sign">⋯</span>
            <span className="diff__text">{l.text}</span>
          </div>
        ) : (
          <div key={i} className={`diff__line diff__line--${l.type}`}>
            {/* The number is decoration for a screen reader — the sign already says
                what happened, and reading a line number before every line is noise. */}
            <span className="diff__no" aria-hidden="true">
              {l.type === 'del' ? l.oldNo : l.newNo}
            </span>
            <span className="diff__sign">{sign(l.type)}</span>
            <LineText text={l.text} mark={marksFor(i, l)} />
          </div>
        )
      )}
      {lines.length > MAX_DIFF_LINES && (
        <div className="diff__more">… {lines.length - MAX_DIFF_LINES} more lines</div>
      )}
    </pre>
  )
}
