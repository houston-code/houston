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
 * Keyboard: focus moves onto the first item on open (or the element marked
 * `data-autofocus`, when a menu wants focus somewhere other than its first item); ArrowUp/Down roves between
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
  roving = true,
  at,
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
  /**
   * Move focus between items on ArrowUp/Down. A menu that keeps focus in its own input
   * and tracks the active item itself (a filterable listbox) turns this off.
   */
  roving?: boolean
  /**
   * Open at this viewport point instead of under the trigger (a right-click menu).
   * The trigger still receives focus back when the menu closes.
   */
  at?: { x: number; y: number }
  children: ReactNode
}): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState<CSSProperties | null>(null)
  // Read onClose live so the effects below arm once and survive parent re-renders.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const rovingRef = useRef(roving)
  rovingRef.current = roving

  const atX = at?.x
  const atY = at?.y
  useLayoutEffect(() => {
    const point = atX !== undefined && atY !== undefined
    const a = point
      ? { top: atY, bottom: atY, left: atX, right: atX }
      : anchorRef.current?.getBoundingClientRect()
    if (!a) return
    // At a point, open toward whichever side has room: rightward unless it is near
    // the window's right edge.
    const side = point ? (atX > window.innerWidth - 260 ? 'right' : 'left') : align
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
      left: side === 'left' ? Math.max(8, Math.min(a.left, window.innerWidth - 8)) : 'auto',
      right: side === 'right' ? Math.max(8, window.innerWidth - a.right) : 'auto'
    })
  }, [anchorRef, align, gap, atX, atY])

  // A left-pinned menu runs rightward from the trigger, so near the window's right
  // edge it would be cut off: once it is laid out, slide it left by what it overhangs.
  // Only ever moves it left, so it settles in one pass.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !style || typeof style.left !== 'number') return
    const width = el.getBoundingClientRect().width
    const left = Math.max(8, Math.min(style.left, window.innerWidth - width - 8))
    if (left < style.left) setStyle({ ...style, left })
  }, [style])

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
    const first =
      menu?.querySelector<HTMLElement>('[data-autofocus]') ?? menu?.querySelector<HTMLElement>(FOCUSABLE)
    first?.focus()
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
      // Tab leaves a menu the way it does a native one: the menu closes and focus goes
      // back to its trigger, instead of the menu staying open while focus wanders off to
      // the far end of the window. A popover holding a form keeps Tab for its fields.
      if (e.key === 'Tab') {
        const menu = ref.current
        if (!menu || !menu.contains(document.activeElement)) return
        if (menu.querySelector('input, textarea, select')) return
        e.preventDefault()
        onCloseRef.current()
        return
      }
      if (rovingRef.current && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
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
    // Scrolling a container that actually holds the trigger (or the page itself)
    // slides a fixed-position menu off its anchor, leaving it floating detached —
    // close in that case. But a scroll in an *unrelated* pane must NOT dismiss the
    // menu: the transcript auto-scrolls on every streaming delta, so closing on any
    // scroll (capture) made the model picker collapse the instant it opened mid-turn.
    // `contains` is true for document/documentElement (page scroll) and for any
    // ancestor scroll container of the trigger; false for a sibling pane like the
    // transcript, whose auto-scroll we now ignore.
    const onScroll = (e: Event): void => {
      const anchor = anchorRef.current
      const target = e.target as Node | null
      if (anchor && target?.contains?.(anchor)) onCloseRef.current()
    }
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
