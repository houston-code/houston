import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { findMatches, setFindHighlights, clearFindHighlights, scrollRangeIntoView } from '../lib/transcriptFind'

/**
 * How long typing must pause before the conversation is searched. Each search walks
 * every text node of the transcript, which in a long chat is tens of thousands, so it
 * runs once per pause rather than once per keystroke. Enter searches at once.
 */
export const FIND_DEBOUNCE_MS = 120

/**
 * In-conversation find bar (⌘F). Highlights every match across the searchable
 * regions and steps through them with Enter / Shift+Enter (or the arrows); Esc
 * closes. The roots are resolved lazily via `getRoots` (e.g. the transcript plus the
 * open plan-review panel) so the bar doesn't couple to those components' internals.
 */
export function FindBar({
  getRoots,
  onClose,
  focusRequest = 0
}: {
  getRoots: () => HTMLElement[]
  onClose: () => void
  /**
   * Bumped each time find is asked for again (⌘F) while the bar is open: focus the
   * field and select its query, ready to type a new one.
   */
  focusRequest?: number
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [count, setCount] = useState(0)
  const [capped, setCapped] = useState(false)
  const [active, setActive] = useState(0)
  const rangesRef = useRef<Range[]>([])
  const activeRef = useRef(0)
  /** The query the current matches are for: behind `query` while a search is waiting. */
  const searchedRef = useRef('')
  const [searched, setSearched] = useState('')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Hand focus back to where it was (usually the message box) when the bar closes,
  // instead of dropping it on the page. Not if the user has since clicked elsewhere.
  // Before the focus effect below, so it records what had focus before the bar did.
  useEffect(() => {
    const returnTo = document.activeElement as HTMLElement | null
    const bar = inputRef.current?.closest('.find-bar')
    return () => {
      const now = document.activeElement
      if (!now || now === document.body || bar?.contains(now)) returnTo?.focus?.()
    }
  }, [])

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusRequest])

  const search = useCallback(
    (q: string) => {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = null
      const found = findMatches(getRoots(), q)
      rangesRef.current = found.ranges
      searchedRef.current = q
      setSearched(q)
      activeRef.current = 0
      setCount(found.ranges.length)
      setCapped(found.capped)
      setActive(0)
      setFindHighlights(found.ranges, 0)
      scrollRangeIntoView(found.ranges[0])
    },
    [getRoots]
  )

  // Recompute and repaint matches once typing pauses. Emptying the box clears at once.
  useEffect(() => {
    if (!query) {
      search('')
      return
    }
    timerRef.current = setTimeout(() => search(query), FIND_DEBOUNCE_MS)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [query, search])

  // Clear the highlights when the bar unmounts.
  useEffect(() => () => clearFindHighlights(), [])

  const go = (dir: 1 | -1): void => {
    // Typed and pressed Enter before the pause ran the search: run it now, then step,
    // as if the results had already been there.
    if (searchedRef.current !== query) search(query)
    const ranges = rangesRef.current
    if (ranges.length === 0) return
    const next = (activeRef.current + dir + ranges.length) % ranges.length
    activeRef.current = next
    setActive(next)
    setFindHighlights(ranges, next)
    scrollRangeIntoView(ranges[next])
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      go(e.shiftKey ? -1 : 1)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  // Describes the last search that ran, which is also what is highlighted: while the
  // next one waits for typing to pause, it keeps showing the previous result.
  const status = query && searched ? (count > 0 ? `${active + 1}/${count}${capped ? '+' : ''}` : 'No results') : ''

  return (
    <div className="find-bar" role="search">
      <input
        ref={inputRef}
        className="find-bar__input"
        type="text"
        placeholder="Find in conversation…"
        aria-label="Find in conversation"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <span className="find-bar__count" aria-live="polite">
        {status}
      </span>
      <button
        className="find-bar__btn"
        onClick={() => go(-1)}
        disabled={count === 0}
        aria-label="Previous match"
        title="Previous match (Shift+Enter)"
      >
        ↑
      </button>
      <button
        className="find-bar__btn"
        onClick={() => go(1)}
        disabled={count === 0}
        aria-label="Next match"
        title="Next match (Enter)"
      >
        ↓
      </button>
      <button className="find-bar__btn" onClick={onClose} aria-label="Close find" title="Close (Esc)">
        ✕
      </button>
    </div>
  )
}
