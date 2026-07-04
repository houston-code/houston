import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

/**
 * Trap keyboard focus inside `ref` while it's mounted (for modal dialogs): focus
 * the first control on open, keep Tab/Shift+Tab within the dialog, close on
 * Escape, and restore focus to the previously-focused element on unmount.
 *
 * `onClose` is read through a ref so a caller passing an inline arrow (a fresh
 * identity every render — the common case) doesn't re-run the effect: re-running
 * it would tear the trap down (restoring focus to the pre-modal element) and
 * re-arm it (yanking focus back to the dialog's first control) on every parent
 * render, stealing focus from whatever the user was typing in.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, onClose: () => void): void {
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const previouslyFocused = document.activeElement as HTMLElement | null

    const focusable = (): HTMLElement[] =>
      Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((e) => e.offsetParent !== null)

    ;(focusable()[0] ?? el).focus()

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCloseRef.current()
        return
      }
      if (e.key !== 'Tab') return
      const items = focusable()
      if (items.length === 0) {
        e.preventDefault()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }

    el.addEventListener('keydown', onKeyDown)
    return () => {
      el.removeEventListener('keydown', onKeyDown)
      previouslyFocused?.focus?.()
    }
    // Intentionally not depending on `onClose`: it's read live through the ref so
    // the trap arms once per mount and survives parent re-renders (see docblock).
  }, [ref])
}
