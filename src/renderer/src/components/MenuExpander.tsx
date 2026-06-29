import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

/** Hover-intent: only open after the pointer rests on the row this long, so a quick
 *  pass over it on the way to another item doesn't flash the card open. */
const OPEN_DELAY = 350
/** Grace after leaving the row/card before closing — long enough to cross the small
 *  gap into the card, short enough not to feel sticky. */
const CLOSE_DELAY = 130

/**
 * A menu row whose nested options open into a floating card to the *right* of the
 * menu when highlighted. Behavior (see the per-handler notes):
 *  - the card sits just past the menu's right edge, never overlapping it;
 *  - the caret sits at the row's far end (CSS `space-between`);
 *  - opening on hover waits {@link OPEN_DELAY} so a quick pass-through is ignored;
 *  - moving onto any other row in the menu closes the card at once (no lingering).
 *
 * The card is `position: fixed` (placed from the menu's rect) so it escapes the
 * menu's scroll clipping, yet stays a DOM child of the row, so it inherits the
 * popover's outside-click handling and keeps its place in the tab order.
 */
export function MenuExpander({
  label,
  children
}: {
  label: ReactNode
  children: ReactNode
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [style, setStyle] = useState<CSSProperties | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearOpen = (): void => {
    if (openTimer.current) clearTimeout(openTimer.current)
    openTimer.current = null
  }
  const clearClose = (): void => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = null
  }
  const doOpen = (): void => {
    clearOpen()
    clearClose()
    setOpen(true)
  }
  const doClose = (): void => {
    clearOpen()
    clearClose()
    setOpen(false)
  }
  const scheduleClose = (): void => {
    clearClose()
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY)
  }
  useEffect(
    () => () => {
      clearOpen()
      clearClose()
    },
    []
  )

  // Place the card just past the *menu's* right edge — anchoring to the trigger
  // button instead would land it inside the menu's padding and overlap the menu.
  // Flip to the menu's left when opening right would run off the viewport.
  useLayoutEffect(() => {
    if (!open) return
    const trigger = triggerRef.current
    if (!trigger) return
    const card = (trigger.closest('.menu') as HTMLElement | null) ?? trigger
    const c = card.getBoundingClientRect()
    const t = trigger.getBoundingClientRect()
    const cardWidth = 200
    const gap = 6
    const flipLeft = c.right + cardWidth + gap > window.innerWidth && c.left - cardWidth - gap >= 0
    setStyle({
      position: 'fixed',
      top: Math.max(8, Math.min(t.top - 4, window.innerHeight - 8)),
      left: flipLeft ? 'auto' : Math.round(c.right + gap),
      right: flipLeft ? Math.round(window.innerWidth - c.left + gap) : 'auto',
      maxHeight: Math.max(160, window.innerHeight - t.top - 8)
    })
  }, [open])

  // While open, hovering any *other* row in the same menu closes the card at once,
  // so it doesn't linger when the pointer moves off to a different item.
  useEffect(() => {
    if (!open) return
    const menu = triggerRef.current?.closest('.menu')
    if (!menu) return
    // Refs + setOpen only (all stable) so the effect's only dependency is `open`.
    const onOver = (e: Event): void => {
      const target = e.target as HTMLElement | null
      if (!target || wrapRef.current?.contains(target)) return
      // Close only when the pointer reaches another *row* — not the menu's own
      // padding/chrome between this row and the card, so the move from row to card
      // stays continuous.
      if (!target.closest('.menu__item')) return
      if (openTimer.current) clearTimeout(openTimer.current)
      if (closeTimer.current) clearTimeout(closeTimer.current)
      openTimer.current = null
      closeTimer.current = null
      setOpen(false)
    }
    menu.addEventListener('mouseover', onOver)
    return () => menu.removeEventListener('mouseover', onOver)
  }, [open])

  return (
    <div
      className="menu__expander"
      ref={wrapRef}
      onMouseEnter={clearClose}
      onMouseLeave={scheduleClose}
      onBlur={(e) => {
        if (!wrapRef.current?.contains(e.relatedTarget as Node | null)) doClose()
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="menu__item menu__item--expander"
        aria-haspopup="true"
        aria-expanded={open}
        // Hover opens only after the intent delay; leaving before it fires cancels it.
        onMouseEnter={() => {
          clearClose()
          if (open) return
          clearOpen()
          openTimer.current = setTimeout(() => setOpen(true), OPEN_DELAY)
        }}
        onMouseLeave={clearOpen}
        // Click and keyboard open immediately (no intent delay).
        onClick={() => (open ? doClose() : doOpen())}
        onFocus={doOpen}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' || e.key === 'Escape') doClose()
          else if (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') doOpen()
        }}
      >
        <span className="menu__expander-label">{label}</span>
        <span className="menu__expander-caret" aria-hidden="true">
          ▸
        </span>
      </button>
      {open && style && (
        <div
          className="menu menu--flyout"
          style={style}
          role="group"
          aria-label={typeof label === 'string' ? label : undefined}
          onMouseEnter={clearClose}
          onMouseLeave={scheduleClose}
        >
          {children}
        </div>
      )}
    </div>
  )
}
