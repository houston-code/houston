import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { TipId } from '@shared/onboarding'
import { isAnyPopoverOpen } from './Popover'

/**
 * A one-shot tip pinned to a real control. The anchor is found by its
 * `data-tour="<id>"` attribute, highlighted while the tip shows, and the card is
 * placed above it when there's room (most anchors sit in the bottom control bar),
 * otherwise below, clamped to the window. Non-modal: it never traps focus, and Esc
 * dismisses it. Focus moves to it only when the user asked for the tour.
 */

export const TIP_COPY: Record<TipId, { title: string; body: string }> = {
  approval: {
    title: 'You stay in control',
    body: 'This sets how much Houston can do without asking. "Ask every time" is a safe start. Plan mode only reads and plans.'
  },
  worktree: {
    title: 'Work on a safe copy',
    body: 'With New worktree on, this chat runs on its own branch in a separate folder, so your current checkout stays untouched.'
  },
  changes: {
    title: 'Review every change',
    body: 'Changes shows the uncommitted edits in this project, file by file.'
  },
  revert: {
    title: 'Every edit is undoable',
    body: 'Revert rolls back the file changes from this turn. Redo puts them back.'
  }
}

const GAP = 10
const MARGIN = 8

/** The on-screen anchor element for a tip, if it's rendered. */
export function tipAnchor(id: TipId): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-tour="${id}"]`)
}

export interface CoachmarkProps {
  id: TipId
  index: number
  total: number
  hasNext: boolean
  /** Take focus on mount (an explicitly requested tour), rather than staying passive. */
  autoFocus?: boolean
  /** The user stepped past this tip ("Next" / "Got it"). */
  onDone: () => void
  /** The user wants no more tips. */
  onSkipAll: () => void
}

export function Coachmark({
  id,
  index,
  total,
  hasNext,
  autoFocus,
  onDone,
  onSkipAll
}: CoachmarkProps): JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null)
  const primaryRef = useRef<HTMLButtonElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number; below: boolean } | null>(null)

  useLayoutEffect(() => {
    const place = (): void => {
      const anchor = tipAnchor(id)
      const card = cardRef.current
      if (!anchor || !card) return
      const a = anchor.getBoundingClientRect()
      const c = card.getBoundingClientRect()
      const below = a.top - GAP - c.height < MARGIN
      const top = below ? a.bottom + GAP : a.top - GAP - c.height
      const centered = a.left + a.width / 2 - c.width / 2
      const left = Math.max(MARGIN, Math.min(centered, window.innerWidth - c.width - MARGIN))
      setPos((p) => (p && p.top === top && p.left === left && p.below === below ? p : { top, left, below }))
    }
    place()
    // The anchor moves when its own box or any ancestor's box changes (the control bar
    // wraps once repo info loads, the composer grows), not only on a window resize, so
    // observe that chain plus the card itself. Nothing runs while the layout is still.
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place)
    if (ro) {
      if (cardRef.current) ro.observe(cardRef.current)
      for (let el = tipAnchor(id); el; el = el.parentElement) ro.observe(el)
    }
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      ro?.disconnect()
    }
  }, [id])

  useEffect(() => {
    const anchor = tipAnchor(id)
    anchor?.classList.add('tour-anchor')
    return () => anchor?.classList.remove('tour-anchor')
  }, [id])

  // Focus only once placed: the card is visibility:hidden until then, and a hidden
  // element can't take focus.
  const placed = pos !== null
  useEffect(() => {
    if (autoFocus && placed) primaryRef.current?.focus()
  }, [id, autoFocus, placed])

  useEffect(() => {
    // Escape dismisses the tip only when it isn't meant for something else: focus is
    // on the tip itself, or on nothing in particular, and no popover menu is open. The
    // find bar, the composer, a menu, or a running turn keep their own Escape. When the
    // tip does take it, it's consumed (capture phase) so the app's global Escape doesn't
    // also act on the same press.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || isAnyPopoverOpen()) return
      const focused = document.activeElement
      const idle = !focused || focused === document.body
      if (!idle && !cardRef.current?.contains(focused)) return
      e.preventDefault()
      onDone()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onDone])

  const copy = TIP_COPY[id]
  return (
    <div
      ref={cardRef}
      className={`coachmark${pos?.below ? ' coachmark--below' : ''}`}
      role="dialog"
      aria-modal="false"
      aria-labelledby={`coachmark-${id}-title`}
      aria-describedby={`coachmark-${id}-body`}
      // Rendered invisibly for one frame so it can be measured before it's placed.
      style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden', top: 0, left: 0 }}
    >
      <p id={`coachmark-${id}-title`} className="coachmark__title">
        {copy.title}
      </p>
      <p id={`coachmark-${id}-body`} className="coachmark__body">
        {copy.body}
      </p>
      <div className="coachmark__foot">
        {total > 1 && (
          <span className="coachmark__count">
            {index} of {total}
          </span>
        )}
        <button type="button" className="coachmark__skip" onClick={onSkipAll}>
          Skip tips
        </button>
        <button ref={primaryRef} type="button" className="btn btn--sm btn--accent" onClick={onDone}>
          {hasNext ? 'Next' : 'Got it'}
        </button>
      </div>
    </div>
  )
}
