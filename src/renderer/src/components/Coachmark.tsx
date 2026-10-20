import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { TipId } from '@shared/onboarding'
import { isAnyPopoverOpen } from './Popover'
import { isMacPlatform } from '../lib/shortcuts'

/**
 * A one-shot tip pinned to a real control. The anchor is found by its `data-tour`
 * attribute (see TIP_ANCHOR), highlighted while the tip shows, and the card is
 * placed above it when there's room (most anchors sit in the bottom control bar),
 * otherwise below, clamped to the window. Non-modal: it never traps focus, and Esc
 * dismisses it. Focus moves to it only when the user asked for the tour.
 */

/** A tip's text. Shortcuts are spelled for the platform (⌘ and ⇧ on macOS). */
export function tipCopy(id: TipId, mac: boolean): { title: string; body: string } {
  // Non-breaking spaces keep a shortcut ("⌘ + ↵") on one line when the body wraps.
  const key = (...parts: string[]): string => parts.join('\u00a0+\u00a0')
  const mod = mac ? '⌘' : 'Ctrl'
  const shift = mac ? '⇧' : 'Shift'
  switch (id) {
    case 'approval':
      return {
        title: 'You stay in control',
        body: `This sets how much Houston can do without asking. Plan mode only reads and plans. ${key(shift, 'Tab')} cycles modes.`
      }
    case 'worktree':
      return {
        title: 'Keep your checkout clean',
        body: 'With New worktree on, this chat runs on its own branch in a separate folder on a separate git worktree.'
      }
    case 'context':
      return {
        title: 'Quick additional context',
        body: '@ adds a file, / runs a command, and a line starting with # saves a rule Houston follows every time.'
      }
    case 'steer':
      return {
        title: 'Redirect it mid-run',
        body: `Steer (↵) sends this now; Houston reads it before its next step. Queue (${key(mod, '↵')}) waits until the run ends.`
      }
    case 'changes':
      return {
        title: 'Review, then ship',
        body: 'Every uncommitted edit, file by file. Open a pull request from here when it looks right.'
      }
    case 'revert':
      return {
        title: 'Every edit is undoable',
        body: `Revert rolls back this turn's file edits. Redo restores them. Everything else: ${key(mod, 'K')}.`
      }
  }
}

/** The control each tip points at (`data-tour` value). Both message-box tips share one. */
const TIP_ANCHOR: Record<TipId, string> = {
  approval: 'approval',
  worktree: 'worktree',
  context: 'composer',
  steer: 'composer',
  changes: 'changes',
  revert: 'revert'
}

const GAP = 10
const MARGIN = 8

/** The on-screen anchor element for a tip, if it's rendered. */
export function tipAnchor(id: TipId): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-tour="${TIP_ANCHOR[id]}"]`)
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

  const copy = tipCopy(id, isMacPlatform())
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
