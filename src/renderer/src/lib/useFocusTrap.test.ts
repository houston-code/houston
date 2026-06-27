import { createElement, useRef, type ReactElement } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useFocusTrap } from './useFocusTrap'

/**
 * The hook filters focusables by `offsetParent !== null` to skip hidden nodes.
 * jsdom never lays out, so every element reports `offsetParent === null`, which
 * would make the trap treat the dialog as having zero focusables. Override the
 * prototype getter to report the element's parent so visible harness controls
 * count as focusable, matching how the trap behaves in a real browser. We
 * restore the original descriptor after each test so the stub can't leak.
 */
const originalOffsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent')

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get(this: HTMLElement) {
      return this.parentElement
    }
  })
})

afterEach(() => {
  if (originalOffsetParent) {
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', originalOffsetParent)
  } else {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetParent
  }
})

/**
 * Minimal modal-like harness: a `tabIndex=-1` container wired to the trap that
 * holds three buttons. Written with `createElement` so this stays a `.ts` file.
 */
function Trap({ onClose }: { onClose: () => void }): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  useFocusTrap(ref, onClose)
  return createElement(
    'div',
    { ref, role: 'dialog', tabIndex: -1 },
    createElement('button', { key: 'a' }, 'first'),
    createElement('button', { key: 'b' }, 'middle'),
    createElement('button', { key: 'c' }, 'last')
  )
}

function renderTrap(onClose: () => void = vi.fn()): {
  dialog: HTMLElement
  first: HTMLElement
  last: HTMLElement
  unmount: () => void
} {
  const { unmount } = render(createElement(Trap, { onClose }))
  return {
    dialog: screen.getByRole('dialog'),
    first: screen.getByRole('button', { name: 'first' }),
    last: screen.getByRole('button', { name: 'last' }),
    unmount
  }
}

describe('useFocusTrap', () => {
  it('moves focus to the first focusable control on mount', () => {
    const { first } = renderTrap()
    expect(document.activeElement).toBe(first)
  })

  it('falls back to focusing the container when it has no focusable children', () => {
    function EmptyTrap(): ReactElement {
      const ref = useRef<HTMLDivElement>(null)
      useFocusTrap(ref, vi.fn())
      return createElement('div', { ref, role: 'dialog', tabIndex: -1 }, 'nothing focusable')
    }
    render(createElement(EmptyTrap))
    expect(document.activeElement).toBe(screen.getByRole('dialog'))
  })

  it('wraps Tab from the last focusable back to the first and prevents the default', () => {
    const { dialog, first, last } = renderTrap()
    last.focus()
    expect(document.activeElement).toBe(last)

    // Dispatch a real cancelable event so we can read `defaultPrevented`: the
    // trap must call `preventDefault` to stop the browser's native Tab move.
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    dialog.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(first)
  })

  it('wraps Shift+Tab from the first focusable back to the last and prevents the default', () => {
    const { dialog, first, last } = renderTrap()
    // Mount already focused `first`.
    expect(document.activeElement).toBe(first)

    const event = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true
    })
    dialog.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(last)
  })

  it('does not steal focus on a forward Tab from a middle control', () => {
    const { dialog, first, last } = renderTrap()
    const middle = screen.getByRole('button', { name: 'middle' })
    middle.focus()

    fireEvent.keyDown(dialog, { key: 'Tab' })
    // The trap only intercepts at the boundaries, so focus stays put.
    expect(document.activeElement).toBe(middle)
    expect(document.activeElement).not.toBe(first)
    expect(document.activeElement).not.toBe(last)
  })

  it('does not steal focus on a Shift+Tab from a middle control', () => {
    const { dialog, first, last } = renderTrap()
    const middle = screen.getByRole('button', { name: 'middle' })
    middle.focus()

    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
    // Shift+Tab only wraps at the first boundary, so focus stays on the middle.
    expect(document.activeElement).toBe(middle)
    expect(document.activeElement).not.toBe(first)
    expect(document.activeElement).not.toBe(last)
  })

  it('invokes onClose and stops propagation when Escape is pressed inside the trap', () => {
    const onClose = vi.fn()
    const { dialog } = renderTrap(onClose)

    // Dispatch a real bubbling event and spy on `stopPropagation`: the trap
    // must call it to keep the Escape from leaking out to outer handlers.
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    const stopPropagation = vi.spyOn(event, 'stopPropagation')
    dialog.dispatchEvent(event)

    expect(onClose).toHaveBeenCalledOnce()
    expect(stopPropagation).toHaveBeenCalledOnce()
  })

  it('ignores unrelated keys', () => {
    const onClose = vi.fn()
    const { dialog, first } = renderTrap(onClose)

    fireEvent.keyDown(dialog, { key: 'a' })
    expect(onClose).not.toHaveBeenCalled()
    // Focus is untouched by a non-Tab/Escape key.
    expect(document.activeElement).toBe(first)
  })

  it('restores focus to the previously-focused element on unmount', () => {
    // A control outside the trap holds focus before the modal opens.
    const opener = document.createElement('button')
    opener.textContent = 'opener'
    document.body.appendChild(opener)
    opener.focus()
    expect(document.activeElement).toBe(opener)

    const { first, unmount } = renderTrap()
    // Opening the trap pulls focus inside.
    expect(document.activeElement).toBe(first)

    unmount()
    // Closing the modal hands focus back to whatever opened it.
    expect(document.activeElement).toBe(opener)

    opener.remove()
  })
})
