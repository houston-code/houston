import type { RefObject } from 'react'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Popover, isAnyPopoverOpen } from './Popover'

afterEach(cleanup)

/** Render a Popover anchored to a real button so getBoundingClientRect resolves. */
function renderPopover(onClose: () => void) {
  const anchor = document.createElement('button')
  document.body.appendChild(anchor)
  const ref: RefObject<HTMLButtonElement> = { current: anchor }
  return render(
    <Popover anchorRef={ref} onClose={onClose}>
      <button className="menu__item">One</button>
      <button className="menu__item">Two</button>
    </Popover>
  )
}

describe('Popover', () => {
  it('registers as open while mounted and clears on unmount', () => {
    expect(isAnyPopoverOpen()).toBe(false)
    const { unmount } = renderPopover(() => {})
    expect(isAnyPopoverOpen()).toBe(true)
    unmount()
    expect(isAnyPopoverOpen()).toBe(false)
  })

  it('closes on Escape and swallows it so a global handler cannot also act', () => {
    const onClose = vi.fn()
    const globalEsc = vi.fn()
    window.addEventListener('keydown', globalEsc)
    renderPopover(onClose)

    fireEvent.keyDown(document.body, { key: 'Escape' })

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(globalEsc).not.toHaveBeenCalled()
    window.removeEventListener('keydown', globalEsc)
  })

  it('closes when the page scrolls (the anchor moves out from under it)', () => {
    const onClose = vi.fn()
    renderPopover(onClose)
    fireEvent.scroll(document, {})
    expect(onClose).toHaveBeenCalled()
  })
})
