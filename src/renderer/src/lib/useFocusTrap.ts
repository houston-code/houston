import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

/**
 * Trap keyboard focus inside `ref` while it's mounted (for modal dialogs): focus
 * the first control on open (or the one marked `data-autofocus`, e.g. a panel's
 * filter field), keep Tab/Shift+Tab within the dialog, close on Escape, and restore
 * focus to the previously-focused element on unmount.
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

    ;(el.querySelector<HTMLElement>('[data-autofocus]') ?? focusable()[0] ?? el).focus()

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

/**
 * Give Escape inside `ref` (an inline editor in a dialog: a draft form, a pasted-text
 * panel) to that editor, so it cancels the editor rather than closing the whole
 * dialog and discarding the draft with it. The listener sits on the editor, which
 * the keydown reaches before the dialog's trap above it. `onEscape` returns false to
 * let the key through (nothing to cancel), and the dialog closes as usual.
 */
export function useEscapeWithin(ref: RefObject<HTMLElement | null>, onEscape: () => boolean | void): void {
  const onEscapeRef = useRef(onEscape)
  onEscapeRef.current = onEscape
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented) return
      const dialog = el.closest<HTMLElement>('[role="dialog"]')
      if (onEscapeRef.current() === false) return
      e.preventDefault()
      e.stopPropagation()
      // Cancelling usually unmounts the editor along with the focused field; keep
      // focus in the dialog so the next Escape (and Tab) still reach it.
      requestAnimationFrame(() => {
        const active = document.activeElement
        if (dialog?.isConnected && (!active || active === document.body)) dialog.focus()
      })
    }
    el.addEventListener('keydown', onKeyDown)
    return () => el.removeEventListener('keydown', onKeyDown)
  }, [ref])
}
