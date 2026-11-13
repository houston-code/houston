import { Fragment, useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject } from 'react'
import { Popover } from './Popover'

/** One entry in a right-click menu. A `separator` draws a rule before the item. */
export interface ContextMenuItem {
  label: string
  onSelect: () => void
  disabled?: boolean
  danger?: boolean
  separator?: boolean
}

/**
 * Right-click menu state for an element: where it was opened, and the handler to put
 * on the element. The menu opens at the pointer; with no pointer (the context-menu
 * key), at the element's top-left corner.
 */
export function useContextMenu<T extends HTMLElement>(): {
  ref: RefObject<T | null>
  at: { x: number; y: number } | null
  onContextMenu: (e: ReactMouseEvent) => void
  close: () => void
} {
  const ref = useRef<T>(null)
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  return {
    ref,
    at,
    onContextMenu: (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.clientX || e.clientY) {
        setAt({ x: e.clientX, y: e.clientY })
        return
      }
      const r = ref.current?.getBoundingClientRect()
      setAt({ x: r?.left ?? 0, y: r?.top ?? 0 })
    },
    close: () => setAt(null)
  }
}

/** The text selected inside `el`, or '' when the selection is empty or elsewhere. */
export function selectionWithin(el: HTMLElement | null): string {
  const sel = typeof window.getSelection === 'function' ? window.getSelection() : null
  if (!el || !sel || sel.isCollapsed || sel.rangeCount === 0) return ''
  const range = sel.getRangeAt(0)
  if (!el.contains(range.commonAncestorContainer)) return ''
  return sel.toString()
}

/** A right-click menu of plain actions, opened at a point (see useContextMenu). */
export function ContextMenu({
  anchorRef,
  at,
  label,
  items,
  onClose
}: {
  anchorRef: RefObject<HTMLElement | null>
  at: { x: number; y: number }
  label: string
  items: ContextMenuItem[]
  onClose: () => void
}): JSX.Element {
  return (
    <Popover anchorRef={anchorRef} at={at} onClose={onClose} role="menu" ariaLabel={label}>
      {items.map((item) => (
        <Fragment key={item.label}>
          {item.separator && <div className="menu__sep" role="separator" />}
          <button
            role="menuitem"
            className={item.danger ? 'menu__item menu__item--danger' : 'menu__item'}
            disabled={item.disabled}
            onClick={() => {
              onClose()
              item.onSelect()
            }}
          >
            {item.label}
          </button>
        </Fragment>
      ))}
    </Popover>
  )
}
