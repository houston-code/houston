import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject
} from 'react'
import { createPortal } from 'react-dom'

/**
 * A dismiss-on-outside-click / Escape popover, portaled to <body> and anchored to a
 * trigger with fixed positioning so no scroll container can clip it.
 *
 * It flips above the anchor when there's little room below and more room above — so a
 * trigger docked near the viewport bottom (the control bar) opens *upward* instead of
 * spilling off-screen — and caps its height to the space on the chosen side, so the
 * menu opens fully visible and only scrolls internally when the content genuinely
 * can't fit. Pin it to the trigger's left or right edge with `align`.
 */
export function Popover({
  anchorRef,
  onClose,
  align = 'right',
  gap = 4,
  className = 'menu',
  role,
  ariaLabel,
  children
}: {
  anchorRef: RefObject<HTMLElement | null>
  onClose: () => void
  /** Which horizontal edge to pin to the trigger. Defaults to the right edge. */
  align?: 'left' | 'right'
  /** Gap in px between the trigger and the menu. */
  gap?: number
  className?: string
  role?: string
  ariaLabel?: string
  children: ReactNode
}): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState<CSSProperties | null>(null)

  useLayoutEffect(() => {
    const a = anchorRef.current?.getBoundingClientRect()
    if (!a) return
    const spaceBelow = window.innerHeight - a.bottom
    const spaceAbove = a.top
    const openUp = spaceBelow < 280 && spaceAbove > spaceBelow
    const maxHeight = Math.max(160, (openUp ? spaceAbove : spaceBelow) - gap - 8)
    // Set all four offsets explicitly (the others as `auto`) so the base `.menu`
    // rule's `top: 100%; right: 0` can't combine with ours and stretch the menu.
    setStyle({
      position: 'fixed',
      maxHeight,
      top: openUp ? 'auto' : a.bottom + gap,
      bottom: openUp ? window.innerHeight - a.top + gap : 'auto',
      left: align === 'left' ? Math.max(8, Math.min(a.left, window.innerWidth - 8)) : 'auto',
      right: align === 'right' ? Math.max(8, window.innerWidth - a.right) : 'auto'
    })
  }, [anchorRef, align, gap])

  useEffect(() => {
    const onDoc = (e: MouseEvent): void => {
      if (
        ref.current &&
        !ref.current.contains(e.target as Node) &&
        !anchorRef.current?.contains(e.target as Node)
      ) {
        onClose()
      }
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose, anchorRef])

  if (!style) return null
  return createPortal(
    <div
      className={className}
      ref={ref}
      style={style}
      role={role}
      aria-label={ariaLabel}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body
  )
}
