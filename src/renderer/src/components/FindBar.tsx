import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import {
  collectMatchRangesAcross,
  setFindHighlights,
  clearFindHighlights,
  scrollRangeIntoView
} from '../lib/transcriptFind'

/**
 * In-conversation find bar (⌘F). Highlights every match across the searchable
 * regions and steps through them with Enter / Shift+Enter (or the arrows); Esc
 * closes. The roots are resolved lazily via `getRoots` (e.g. the transcript plus the
 * open plan-review panel) so the bar doesn't couple to those components' internals.
 */
export function FindBar({
  getRoots,
  onClose
}: {
  getRoots: () => HTMLElement[]
  onClose: () => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [count, setCount] = useState(0)
  const [active, setActive] = useState(0)
  const rangesRef = useRef<Range[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Recompute and repaint matches whenever the query changes.
  useEffect(() => {
    const ranges = collectMatchRangesAcross(getRoots(), query)
    rangesRef.current = ranges
    setCount(ranges.length)
    setActive(0)
    setFindHighlights(ranges, 0)
    scrollRangeIntoView(ranges[0])
  }, [query, getRoots])

  // Clear the highlights when the bar unmounts.
  useEffect(() => () => clearFindHighlights(), [])

  const go = (dir: 1 | -1): void => {
    const ranges = rangesRef.current
    if (ranges.length === 0) return
    const next = (active + dir + ranges.length) % ranges.length
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

  const status = query ? (count > 0 ? `${active + 1}/${count}` : 'No results') : ''

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
