import {
  cloneElement,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'

/**
 * Timing for the titlebar's custom tooltips. They replace the native `title`
 * tooltip, which is both slow (a ~0.5s OS delay) and janky (moving to a
 * neighbouring button restarts that whole delay from scratch). We want "instant
 * yet smooth":
 *  - OPEN_DELAY — a tiny delay on the *first* hover so a tooltip doesn't flash
 *    while the pointer is merely passing over the action row,
 *  - SKIP_WINDOW — once one tooltip has shown, hovering a sibling within this
 *    window shows it immediately (no second delay as you move along the row),
 *  - HIDE_GRACE — a short close delay so crossing the gap between two buttons
 *    (a brief mouseleave→mouseenter) doesn't blink the tooltip off then on.
 */
const OPEN_DELAY = 60
const SKIP_WINDOW = 400
const HIDE_GRACE = 60
/** Gap (px) between the trigger's bottom edge and the tooltip. */
const GAP = 6
/** Keep the tooltip at least this far from the viewport edges when clamping. */
const EDGE = 8

interface Ctx {
  show: (el: HTMLElement, label: ReactNode) => void
  hide: () => void
}
const TooltipCtx = createContext<Ctx | null>(null)

interface Active {
  el: HTMLElement
  label: ReactNode
}

/** Props we merge onto a wrapped trigger; the trigger keeps its own accessible name. */
interface TriggerProps {
  onMouseEnter?: (e: MouseEvent<HTMLElement>) => void
  onMouseLeave?: (e: MouseEvent<HTMLElement>) => void
  onFocus?: (e: FocusEvent<HTMLElement>) => void
  onBlur?: (e: FocusEvent<HTMLElement>) => void
}

/**
 * Owns the single floating tooltip shared by every {@link Tooltip} inside it.
 * One shared element (rather than one per trigger) is what makes moving between
 * buttons smooth: it simply re-anchors and swaps its text instead of one tip
 * fading out while a separate one fades in.
 */
export function TooltipProvider({ children }: { children: ReactNode }): JSX.Element {
  const [active, setActive] = useState<Active | null>(null)
  const [shown, setShown] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const lastHiddenAt = useRef(0)
  // Read `shown` through a ref so `show`/`hide` stay referentially stable — the
  // context value below can then be memoised, so triggers don't re-render on
  // every tooltip state change and the disabled-dismiss effect fires only on
  // real changes.
  const shownRef = useRef(false)
  shownRef.current = shown

  const show = useCallback((el: HTMLElement, label: ReactNode) => {
    clearTimeout(hideTimer.current)
    clearTimeout(openTimer.current)
    setActive({ el, label })
    // Already showing, or a tooltip was visible a moment ago → skip the delay.
    if (shownRef.current || Date.now() - lastHiddenAt.current < SKIP_WINDOW) {
      setShown(true)
    } else {
      openTimer.current = setTimeout(() => setShown(true), OPEN_DELAY)
    }
  }, [])

  const hide = useCallback(() => {
    clearTimeout(openTimer.current)
    hideTimer.current = setTimeout(() => {
      setShown(false)
      setActive(null)
      lastHiddenAt.current = Date.now()
    }, HIDE_GRACE)
  }, [])

  const ctx = useMemo<Ctx>(() => ({ show, hide }), [show, hide])

  // Re-anchor under the active trigger, clamped so a right-edge button's tip
  // doesn't spill off-screen. Runs after the label has committed, so measuring
  // the tip's width reflects the current text.
  useLayoutEffect(() => {
    if (!active) {
      setPos(null)
      return
    }
    const r = active.el.getBoundingClientRect()
    const tw = tipRef.current?.offsetWidth ?? 0
    const left = Math.round(
      Math.min(Math.max(r.left + r.width / 2 - tw / 2, EDGE), window.innerWidth - tw - EDGE)
    )
    setPos({ top: Math.round(r.bottom + GAP), left })
  }, [active])

  useEffect(
    () => () => {
      clearTimeout(openTimer.current)
      clearTimeout(hideTimer.current)
    },
    []
  )

  return (
    <TooltipCtx.Provider value={ctx}>
      {children}
      {active &&
        createPortal(
          <div
            ref={tipRef}
            className={`tt${shown && pos ? ' tt--shown' : ''}`}
            role="tooltip"
            style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
          >
            {active.label}
          </div>,
          document.body
        )}
    </TooltipCtx.Provider>
  )
}

/**
 * Give a single focusable trigger (an icon button) a shared, instant-yet-smooth
 * tooltip. Handlers are merged onto the child itself (via cloneElement) so no
 * wrapper element is added to the layout. `disabled` skips the tooltip (e.g.
 * while the trigger's own popover is open). The child must still carry its own
 * `aria-label`: this tooltip is a visual affordance, not the accessible name.
 * Outside a {@link TooltipProvider} it renders the child untouched.
 */
export function Tooltip({
  label,
  disabled = false,
  children
}: {
  label: ReactNode
  disabled?: boolean
  children: ReactElement
}): ReactElement {
  const ctx = useContext(TooltipCtx)
  // Actively dismiss the shared tip when this trigger becomes disabled — e.g. its
  // popover just opened. The pointer is still over the (now click-activated)
  // button, so without this a tip shown on hover would stay stuck under the menu.
  useEffect(() => {
    if (disabled) ctx?.hide()
  }, [disabled, ctx])
  if (!ctx || disabled) return children
  const prev = children.props as TriggerProps
  return cloneElement(children as ReactElement<TriggerProps>, {
    onMouseEnter: (e: MouseEvent<HTMLElement>) => {
      prev.onMouseEnter?.(e)
      ctx.show(e.currentTarget, label)
    },
    onMouseLeave: (e: MouseEvent<HTMLElement>) => {
      prev.onMouseLeave?.(e)
      ctx.hide()
    },
    onFocus: (e: FocusEvent<HTMLElement>) => {
      prev.onFocus?.(e)
      ctx.show(e.currentTarget, label)
    },
    onBlur: (e: FocusEvent<HTMLElement>) => {
      prev.onBlur?.(e)
      ctx.hide()
    }
  })
}
