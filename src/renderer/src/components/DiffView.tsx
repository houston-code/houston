import { memo, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { numberDiff, replacementPairs, tokenize, wordDiff, type DiffLine, type NumberedLine } from '@shared/diff'
import { diffLanguage, highlightLine, markRuns } from '../lib/diffHighlight'

/**
 * Cap how many diff lines render at once so a huge change can't lock the UI. Past
 * it, "Show more" reveals the rest one chunk of this size at a time.
 */
export const MAX_DIFF_LINES = 300

/** How many lines to render: whole chunks, enough to reach `need` lines. */
export function shownCount(total: number, chunks: number, need = 0): number {
  const want = Math.max(chunks, Math.ceil(need / MAX_DIFF_LINES)) * MAX_DIFF_LINES
  return Math.min(total, want)
}

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
 * when the file's language is known, syntax colour. Memoized (its `mark` comes from the
 * diff's memo below), so a diff that renders again unchanged doesn't re-highlight.
 */
const LineText = memo(function LineText({
  text,
  mark,
  lang
}: {
  text: string
  mark?: boolean[]
  lang: string | null
}): JSX.Element {
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
})

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

/** A line someone can comment on: which side of the diff, its number there, its code. */
export interface DiffLineTarget {
  side: 'old' | 'new'
  line: number
  text: string
}

/** The key a line's comments are filed under in `renderBelow`. */
export function lineKey(t: Pick<DiffLineTarget, 'side' | 'line'>): string {
  return `${t.side}:${t.line}`
}

function targetOf(l: NumberedLine, side?: 'old' | 'new'): DiffLineTarget | null {
  if (l.type === 'skip') return null
  const s = side ?? (l.type === 'del' ? 'old' : 'new')
  const line = s === 'old' ? l.oldNo : l.newNo
  return line === undefined ? null : { side: s, line, text: l.text }
}

/** Open a comment from a click on the line, unless the click ended a text selection. */
function clickOpens(): boolean {
  const sel = typeof window !== 'undefined' ? window.getSelection() : null
  return !sel || sel.isCollapsed || sel.toString() === ''
}

export interface DiffViewProps {
  diff: DiffLine[]
  /** The file's path, to pick a syntax-highlighting language from its extension. */
  path?: string
  /** The first old and new line numbers (a hunk's position in its file); default 1. */
  start?: { old: number; new: number }
  layout?: DiffLayout
  /** Lines take comments: a click on one (or its number) asks to comment on it. */
  onLineClick?: (target: DiffLineTarget) => void
  /** What to show under a line (its comments, an open editor), by {@link lineKey}. */
  renderBelow?: (key: string) => ReactNode
  /**
   * Lines (by {@link lineKey}) that must be rendered even past the cap, such as the
   * ones holding comments, so nothing attached to a line is out of sight.
   */
  reveal?: ReadonlySet<string>
}

/** The lines and the marks within them, which hold for as long as the diff does. */
interface DiffRows {
  lines: NumberedLine[]
  /** The changed words of each line of a replacement, by index into `lines`. */
  marks: (boolean[] | undefined)[]
  /** Gutter width from the largest number in the whole diff, so it doesn't jitter. */
  width: number
}

function diffRows(diff: DiffLine[], startOld: number | undefined, startNew: number | undefined): DiffRows {
  const numbered = numberDiff(diff)
  const lines =
    startOld === undefined || startNew === undefined
      ? numbered
      : numbered.map((l) => ({
          ...l,
          ...(l.oldNo !== undefined ? { oldNo: l.oldNo + startOld - 1 } : {}),
          ...(l.newNo !== undefined ? { newNo: l.newNo + startNew - 1 } : {})
        }))
  // A del followed by its add is a replacement, so the changed words can be marked
  // inside both. Computed over the whole diff before slicing, so the pairing does
  // not change with where the cap happens to fall.
  const marks: (boolean[] | undefined)[] = new Array(lines.length)
  for (const [del, add] of replacementPairs(lines)) {
    const words = wordDiff(lines[del].text, lines[add].text)
    marks[del] = words.del
    marks[add] = words.add
  }
  const width = Math.max(2, ...lines.map((l) => String(Math.max(l.oldNo ?? 0, l.newNo ?? 0)).length))
  return { lines, marks, width }
}

/**
 * Re-render only for a change that shows: `start` and `reveal` are rebuilt by callers
 * on every render, so they compare by value.
 */
function sameDiffProps(a: DiffViewProps, b: DiffViewProps): boolean {
  return (
    a.diff === b.diff &&
    a.path === b.path &&
    a.start?.old === b.start?.old &&
    a.start?.new === b.start?.new &&
    a.layout === b.layout &&
    a.onLineClick === b.onLineClick &&
    a.renderBelow === b.renderBelow &&
    sameKeys(a.reveal, b.reveal)
  )
}

function sameKeys(a: ReadonlySet<string> | undefined, b: ReadonlySet<string> | undefined): boolean {
  if (a === b) return true
  if ((a?.size ?? 0) !== (b?.size ?? 0)) return false
  for (const k of a ?? []) if (!b?.has(k)) return false
  return true
}

export const DiffView = memo(function DiffView({
  diff,
  path,
  start,
  layout = 'unified',
  onLineClick,
  renderBelow,
  reveal
}: DiffViewProps): JSX.Element {
  const [chunks, setChunks] = useState(1)
  // With comments on, the line numbers are buttons: one Tab stop for the whole view
  // (the one used last, else the first), and ArrowUp/ArrowDown move between them.
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const preRef = useRef<HTMLPreElement>(null)
  const { lines, marks, width } = useMemo(() => diffRows(diff, start?.old, start?.new), [diff, start?.old, start?.new])
  const lang = diffLanguage(path)
  const marksFor = (i: number): boolean[] | undefined => marks[i]

  // The last line something attached to must stay visible: reveal through it.
  let need = 0
  if (reveal && reveal.size > 0) {
    lines.forEach((l, i) => {
      if (l.type === 'skip') return
      const t = targetOf(l)
      if (t && reveal.has(lineKey(t))) need = i + 1
    })
  }
  const count = shownCount(lines.length, chunks, need)
  const shown = lines.slice(0, count)
  const hidden = lines.length - count
  const more =
    hidden > 0 ? (
      <div className="diff__more">
        <button
          type="button"
          className="diff__more-btn"
          onClick={() => setChunks(Math.ceil(count / MAX_DIFF_LINES) + 1)}
        >
          Show {Math.min(hidden, MAX_DIFF_LINES)} more line{Math.min(hidden, MAX_DIFF_LINES) === 1 ? '' : 's'}
        </button>
        <span className="diff__more-count">{hidden} hidden</span>
      </div>
    ) : null

  // The line-number buttons in the order they render.
  const buttonKeys: string[] = []
  if (onLineClick) {
    if (layout === 'split') {
      for (const r of splitRows(shown)) {
        if (r.skip !== undefined) continue
        const left = r.left !== undefined ? shown[r.left] : undefined
        const right = r.right !== undefined ? shown[r.right] : undefined
        const lt = left && left.type !== 'ctx' ? targetOf(left) : null
        const rt = right ? targetOf(right, right.type === 'ctx' ? 'new' : undefined) : null
        if (lt) buttonKeys.push(lineKey(lt))
        if (rt) buttonKeys.push(lineKey(rt))
      }
    } else {
      for (const l of shown) {
        const t = targetOf(l)
        if (t) buttonKeys.push(lineKey(t))
      }
    }
  }
  const tabbable = focusKey !== null && buttonKeys.includes(focusKey) ? focusKey : (buttonKeys[0] ?? null)
  const onGutterKey = (e: ReactKeyboardEvent<HTMLButtonElement>, key: string): void => {
    const i = buttonKeys.indexOf(key)
    let next: number
    if (e.key === 'ArrowDown') next = Math.min(buttonKeys.length - 1, i + 1)
    else if (e.key === 'ArrowUp') next = Math.max(0, i - 1)
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = buttonKeys.length - 1
    else return
    e.preventDefault()
    const target = buttonKeys[next]
    setFocusKey(target)
    preRef.current?.querySelector<HTMLElement>(`[data-line-key="${target}"]`)?.focus()
  }

  // The line number, or with comments on, a button that opens a comment on the line.
  const gutterNo = (t: DiffLineTarget | null, shown: number | undefined): JSX.Element =>
    onLineClick && t ? (
      <button
        type="button"
        className="diff__no diff__no--btn"
        data-line-key={lineKey(t)}
        tabIndex={lineKey(t) === tabbable ? 0 : -1}
        onFocus={() => setFocusKey(lineKey(t))}
        onKeyDown={(e) => onGutterKey(e, lineKey(t))}
        aria-label={`Comment on ${t.side === 'old' ? 'removed ' : ''}line ${t.line}${path ? ` of ${path}` : ''}`}
        onClick={(e) => {
          e.stopPropagation()
          onLineClick(t)
        }}
      >
        {shown}
      </button>
    ) : (
      <span className="diff__no" aria-hidden="true">
        {shown}
      </span>
    )
  const lineClick = (t: DiffLineTarget | null): { onClick?: () => void } =>
    onLineClick && t ? { onClick: () => clickOpens() && onLineClick(t) } : {}
  const below = (t: DiffLineTarget | null): ReactNode => (renderBelow && t ? renderBelow(lineKey(t)) : null)

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
      // An unchanged line is one line on both sides: either half comments on it as the
      // new line (where its comments show), and only the right half's number is the
      // keyboard button, so the row doesn't offer the same action twice.
      const t = targetOf(l, l.type === 'ctx' ? 'new' : undefined)
      return (
        <div className={`diff__line diff__line--${type}${onLineClick ? ' diff__line--commentable' : ''}`} {...lineClick(t)}>
          {gutterNo(l.type === 'ctx' && side === 'old' ? null : t, side === 'old' ? l.oldNo : l.newNo)}
          <span className="diff__sign">{sign(type)}</span>
          <LineText text={l.text} mark={marksFor(i)} lang={lang} />
        </div>
      )
    }
    return (
      <pre ref={preRef} className="diff diff--split" style={{ ['--diff-gutter' as string]: `${width}ch` }}>
        {splitRows(shown).map((r, k) =>
          r.skip !== undefined ? (
            skipLine(shown[r.skip], k)
          ) : (
            <div key={k} className="diff__rowgroup">
              <div className="diff__row">
                {half(r.left, 'old')}
                {half(r.right, 'new')}
              </div>
              {r.left !== undefined && shown[r.left].type === 'del' && below(targetOf(shown[r.left]))}
              {r.right !== undefined && below(targetOf(shown[r.right], 'new'))}
            </div>
          )
        )}
        {more}
      </pre>
    )
  }

  return (
    <pre ref={preRef} className="diff" style={{ ['--diff-gutter' as string]: `${width}ch` }}>
      {shown.map((l, i) =>
        // A `skip` stands for unchanged lines folded away by hunkDiff; showing it
        // as a normal line would print the count as if it were code.
        l.type === 'skip' ? (
          skipLine(l, i)
        ) : (
          <div key={i} className="diff__linegroup">
            <div className={`diff__line diff__line--${l.type}${onLineClick ? ' diff__line--commentable' : ''}`} {...lineClick(targetOf(l))}>
              {/* The number is decoration for a screen reader (the sign already says
                  what happened), unless it is the button that comments on the line. */}
              {gutterNo(targetOf(l), l.type === 'del' ? l.oldNo : l.newNo)}
              <span className="diff__sign">{sign(l.type)}</span>
              <LineText text={l.text} mark={marksFor(i)} lang={lang} />
            </div>
            {below(targetOf(l))}
          </div>
        )
      )}
      {more}
    </pre>
  )
}, sameDiffProps)
