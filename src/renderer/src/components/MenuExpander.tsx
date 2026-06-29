import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

/**
 * A menu row whose nested options open into a floating card to the *right* of the
 * row when highlighted — hovered with the mouse or focused via the keyboard —
 * instead of expanding the menu inline.
 *
 * The card is `position: fixed`, placed from the row's rect, so it escapes the
 * parent menu's scroll clipping; yet it stays a DOM child of the row, so it inherits
 * the menu's outside-click handling, hovering it never fires the row's mouseleave,
 * and it keeps its place in the tab order. A short close delay bridges the small gap
 * between row and card so the pointer can travel across without dismissing it.
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
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancelClose = (): void => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = null
  }
  const openNow = (): void => {
    cancelClose()
    setOpen(true)
  }
  const closeSoon = (): void => {
    cancelClose()
    closeTimer.current = setTimeout(() => setOpen(false), 140)
  }
  const closeNow = (): void => {
    cancelClose()
    setOpen(false)
  }
  // Clear a pending close if the menu unmounts (e.g. an item closed the popover).
  useEffect(() => () => cancelClose(), [])

  // Place the card beside the row; flip to its left when the right would overflow
  // the viewport. Recomputed on each open (the menu is short-lived).
  useLayoutEffect(() => {
    if (!open) return
    const r = triggerRef.current?.getBoundingClientRect()
    if (!r) return
    const cardWidth = 200
    const gap = 2
    const flipLeft = r.right + cardWidth + gap > window.innerWidth && r.left - cardWidth - gap >= 0
    setStyle({
      position: 'fixed',
      top: Math.max(8, Math.min(r.top - 4, window.innerHeight - 8)),
      left: flipLeft ? 'auto' : Math.round(r.right + gap),
      right: flipLeft ? Math.round(window.innerWidth - r.left + gap) : 'auto',
      maxHeight: Math.max(160, window.innerHeight - r.top - 8)
    })
  }, [open])

  return (
    <div
      className="menu__expander"
      ref={wrapRef}
      onMouseEnter={openNow}
      onMouseLeave={closeSoon}
      onBlur={(e) => {
        if (!wrapRef.current?.contains(e.relatedTarget as Node | null)) closeNow()
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="menu__item menu__item--expander"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => (open ? closeNow() : openNow())}
        onFocus={openNow}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' || e.key === 'Escape') closeNow()
          else if (e.key === 'ArrowRight') openNow()
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
          onMouseEnter={cancelClose}
          onMouseLeave={closeSoon}
        >
          {children}
        </div>
      )}
    </div>
  )
}
