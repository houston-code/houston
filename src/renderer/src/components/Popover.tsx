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
 * Number of Popovers currently mounted. The global keyboard handler consults this
 * (via {@link isAnyPopoverOpen}) so an app-level shortcut like Shift+Tab (cycle
 * approval mode) doesn't fire "underneath" an open menu — the menu, being portaled
 * to <body>, is otherwise invisible to that handler's open-overlay checks.
 */
let openPopoverCount = 0
export function isAnyPopoverOpen(): boolean {
  return openPopoverCount > 0
}

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

/**
 * A dismiss-on-outside-click / Escape popover, portaled to <body> and anchored to a
 * trigger with fixed positioning so no scroll container can clip it.
 *
 * It flips above the anchor when there's little room below and more room above — so a
 * trigger docked near the viewport bottom (the control bar) opens *upward* instead of
 * spilling off-screen — and caps its height to the space on the chosen side, so the
 * menu opens fully visible and only scrolls internally when the content genuinely
 * can't fit. Pin it to the trigger's left or right edge with `align`.
 *
 * Keyboard: focus moves onto the first item on open; ArrowUp/Down roves between
 * items; Escape closes (and is swallowed so it can't also cancel a running turn);
 * focus is restored to the trigger on close.
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
  // Read onClose live so the effects below arm once and survive parent re-renders.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

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

  // Track how many popovers are open, for the app-level shortcut guard.
  useEffect(() => {
    openPopoverCount += 1
    return () => {
      openPopoverCount = Math.max(0, openPopoverCount - 1)
    }
  }, [])

  // Move focus into the menu on open and restore it to the trigger on close, so a
  // keyboard user can operate the menu and lands back where they were afterwards.
  // Only restore when focus is still inside the (about-to-unmount) menu or has
  // fallen to <body>; if the user clicked a different control we leave it there.
  const positioned = style !== null
  useEffect(() => {
    if (!positioned) return
    const trigger = anchorRef.current
    const menu = ref.current
    menu?.querySelector<HTMLElement>(FOCUSABLE)?.focus()
    return () => {
      const active = document.activeElement
      if (!active || active === document.body || menu?.contains(active)) trigger?.focus?.()
    }
  }, [anchorRef, positioned])

  useEffect(() => {
    const onDoc = (e: MouseEvent): void => {
      if (
        ref.current &&
        !ref.current.contains(e.target as Node) &&
        !anchorRef.current?.contains(e.target as Node)
      ) {
        onCloseRef.current()
      }
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        // Swallow it so the app-level handler can't also read this Escape as
        // "stop the running turn" / "close an unrelated panel".
        e.preventDefault()
        e.stopPropagation()
        onCloseRef.current()
        return
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const menu = ref.current
        if (!menu || !menu.contains(document.activeElement)) return
        const items = Array.from(menu.querySelectorAll<HTMLElement>(FOCUSABLE))
        if (items.length === 0) return
        e.preventDefault()
        const i = items.indexOf(document.activeElement as HTMLElement)
        const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length
        items[next]?.focus()
      }
    }
    // Scrolling the page moves the trigger out from under a fixed-position menu,
    // leaving it floating detached; close on any scroll (capture, to catch nested
    // scroll containers) — matching how it already closes on resize.
    const onScroll = (): void => onCloseRef.current()
    const onResize = (): void => onCloseRef.current()
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [anchorRef])

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
