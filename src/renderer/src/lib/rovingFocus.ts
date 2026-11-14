import type { KeyboardEvent } from 'react'

/**
 * Keyboard movement for a composite widget with a roving tab stop (a tree, a list):
 * the widget is one stop in the Tab order, and the arrow keys move focus between its
 * items. See the WAI-ARIA Authoring Practices tree view and listbox patterns.
 */

/** The item index Up / Down / Home / End move to from `current` of `count`, or null for other keys. */
export function listMove(key: string, current: number, count: number): number | null {
  if (count === 0) return null
  switch (key) {
    case 'ArrowDown':
      return Math.min(count - 1, current + 1)
    case 'ArrowUp':
      return Math.max(0, current - 1)
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

/**
 * The item that keeps the widget's tab stop: the one last focused if it is still
 * shown, else the preferred one (the selection) if shown, else the first.
 */
export function tabStop<T>(items: readonly T[], focused: T | null, preferred: T | null): T | null {
  if (focused !== null && items.includes(focused)) return focused
  if (preferred !== null && items.includes(preferred)) return preferred
  return items[0] ?? null
}

/**
 * Key handling for a tree whose items are the elements with `role="treeitem"` under
 * the handler's element, in display order, each carrying `aria-level` and (a folder)
 * `aria-expanded`. Up/Down/Home/End move; Right opens a closed folder or steps into
 * an open one; Left closes an open folder or steps out to the parent. Opening and
 * closing click the item, which is what a pointer would do. Enter and Space are left
 * to the item (a button activates on its own).
 */
export function treeKeyDown(e: KeyboardEvent<HTMLElement>): void {
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]')]
  const i = items.indexOf(e.target as HTMLElement)
  if (i < 0) return
  const cur = items[i]
  const level = Number(cur.getAttribute('aria-level') ?? 1)
  const expanded = cur.getAttribute('aria-expanded')
  let target: HTMLElement | undefined
  const moved = listMove(e.key, i, items.length)
  if (moved !== null) target = items[moved]
  else if (e.key === 'ArrowRight') {
    if (expanded === 'false') cur.click()
    else if (expanded === 'true') {
      const next = items[i + 1]
      if (next && Number(next.getAttribute('aria-level') ?? 1) === level + 1) target = next
    }
  } else if (e.key === 'ArrowLeft') {
    if (expanded === 'true') cur.click()
    else
      for (let k = i - 1; k >= 0; k--)
        if (Number(items[k].getAttribute('aria-level') ?? 1) < level) {
          target = items[k]
          break
        }
  } else return
  e.preventDefault()
  target?.focus()
}
