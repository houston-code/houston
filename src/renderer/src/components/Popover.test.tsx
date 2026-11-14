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

  it('closes on Tab from inside a menu, but leaves Tab to a form inside it', () => {
    const onClose = vi.fn()
    const { getByText } = renderPopover(onClose)
    getByText('One').focus()
    const tab = fireEvent.keyDown(getByText('One'), { key: 'Tab' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(tab).toBe(false)
    cleanup()

    const onCloseForm = vi.fn()
    const anchor = document.createElement('button')
    document.body.appendChild(anchor)
    const { getByLabelText } = render(
      <Popover anchorRef={{ current: anchor }} onClose={onCloseForm}>
        <input aria-label="Link" />
        <button>Add</button>
      </Popover>
    )
    getByLabelText('Link').focus()
    fireEvent.keyDown(getByLabelText('Link'), { key: 'Tab' })
    expect(onCloseForm).not.toHaveBeenCalled()
  })

  it('closes when the page scrolls (the anchor moves out from under it)', () => {
    const onClose = vi.fn()
    renderPopover(onClose)
    fireEvent.scroll(document, {})
    expect(onClose).toHaveBeenCalled()
  })

  it('closes when a scroll container holding the anchor scrolls', () => {
    const onClose = vi.fn()
    const scroller = document.createElement('div')
    const anchor = document.createElement('button')
    scroller.appendChild(anchor)
    document.body.appendChild(scroller)
    const ref: RefObject<HTMLButtonElement> = { current: anchor }
    render(
      <Popover anchorRef={ref} onClose={onClose}>
        <button className="menu__item">One</button>
      </Popover>
    )
    fireEvent.scroll(scroller, {})
    expect(onClose).toHaveBeenCalled()
    scroller.remove()
  })

  it('ignores a scroll in an unrelated pane (e.g. the transcript auto-scrolling mid-turn)', () => {
    // Regression: the transcript auto-scrolls on every streaming delta, which used to
    // close the model picker the instant it opened during a running turn. A scroll in a
    // pane that does NOT contain the anchor must leave the menu open.
    const onClose = vi.fn()
    const pane = document.createElement('div')
    document.body.appendChild(pane)
    renderPopover(onClose)
    fireEvent.scroll(pane, {})
    expect(onClose).not.toHaveBeenCalled()
    pane.remove()
  })
})

describe('Popover placement', () => {
  /** A rect for jsdom, which lays nothing out. */
  const rect = (left: number, top: number, width: number, height: number): DOMRect =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }) as DOMRect

  it('keeps a left-pinned menu inside the window when its trigger is near the right edge', () => {
    const anchor = document.createElement('button')
    document.body.appendChild(anchor)
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      return this === anchor ? rect(window.innerWidth - 120, 100, 100, 24) : rect(0, 0, 360, 200)
    })
    try {
      const ref: RefObject<HTMLButtonElement> = { current: anchor }
      render(
        <Popover anchorRef={ref} onClose={() => {}} align="left" className="menu choice-menu">
          <button className="menu__item">One</button>
        </Popover>
      )
      const menu = document.querySelector('.choice-menu') as HTMLElement
      expect(menu.style.left).toBe(`${window.innerWidth - 360 - 8}px`)
    } finally {
      spy.mockRestore()
      anchor.remove()
    }
  })

  it('leaves a left-pinned menu at its trigger when it fits', () => {
    const anchor = document.createElement('button')
    document.body.appendChild(anchor)
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      return this === anchor ? rect(40, 100, 100, 24) : rect(0, 0, 360, 200)
    })
    try {
      const ref: RefObject<HTMLButtonElement> = { current: anchor }
      render(
        <Popover anchorRef={ref} onClose={() => {}} align="left" className="menu choice-menu">
          <button className="menu__item">One</button>
        </Popover>
      )
      expect((document.querySelector('.choice-menu') as HTMLElement).style.left).toBe('40px')
    } finally {
      spy.mockRestore()
      anchor.remove()
    }
  })
})

describe('Popover roving focus', () => {
  function renderWith(roving: boolean) {
    const anchor = document.createElement('button')
    document.body.appendChild(anchor)
    const ref: RefObject<HTMLButtonElement> = { current: anchor }
    return render(
      <Popover anchorRef={ref} onClose={() => {}} roving={roving}>
        <input aria-label="filter" />
        <button className="menu__item">One</button>
      </Popover>
    )
  }

  it('moves focus between items on ArrowDown by default', () => {
    const { getByLabelText, getByText } = renderWith(true)
    getByLabelText('filter').focus()
    fireEvent.keyDown(getByLabelText('filter'), { key: 'ArrowDown' })
    expect(getByText('One')).toHaveFocus()
  })

  it('leaves focus in place when roving is off, for a menu that tracks its own active item', () => {
    const { getByLabelText } = renderWith(false)
    getByLabelText('filter').focus()
    fireEvent.keyDown(getByLabelText('filter'), { key: 'ArrowDown' })
    expect(getByLabelText('filter')).toHaveFocus()
  })
})
