import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'

/** How far one arrow press moves a panel edge, as the sidebar's does. */
export const PANEL_NUDGE_STEP = 16

/** A panel's size, for its resizer's keyboard and double-click controls. */
export interface PanelSize {
  value: number
  min: number
  max: number
  /** The first-launch size, which a double-click restores. */
  defaultValue: number
  /** Set (and remember) a new size; the owner clamps it. */
  onChange: (px: number) => void
}

/**
 * The drag handle on a docked panel's inner edge: `left` for a panel on the right
 * (the dock, the side chat), `top` for one at the bottom (the terminal). Dragging is
 * the owner's `onMouseDown`; with `size` it is also a focusable separator that the
 * arrow keys move (toward the arrow) and a double-click puts back to its default.
 */
export function PanelResizer({
  className,
  label,
  edge,
  size,
  onMouseDown
}: {
  className: string
  label: string
  edge: 'left' | 'top'
  size?: PanelSize
  onMouseDown: (e: ReactMouseEvent) => void
}): JSX.Element {
  const grow = edge === 'left' ? 'ArrowLeft' : 'ArrowUp'
  const shrink = edge === 'left' ? 'ArrowRight' : 'ArrowDown'
  const onKeyDown = (e: ReactKeyboardEvent): void => {
    if (!size || (e.key !== grow && e.key !== shrink)) return
    e.preventDefault()
    size.onChange(size.value + (e.key === grow ? PANEL_NUDGE_STEP : -PANEL_NUDGE_STEP))
  }
  return (
    <div
      className={className}
      role="separator"
      aria-orientation={edge === 'left' ? 'vertical' : 'horizontal'}
      aria-label={label}
      {...(size
        ? { tabIndex: 0, 'aria-valuenow': size.value, 'aria-valuemin': size.min, 'aria-valuemax': size.max }
        : {})}
      onMouseDown={onMouseDown}
      onKeyDown={onKeyDown}
      onDoubleClick={size ? () => size.onChange(size.defaultValue) : undefined}
    />
  )
}
