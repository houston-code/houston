import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { MenuExpander } from './MenuExpander'

/** Render the expander inside a `.menu` with a sibling row, mirroring the real menu. */
function setup(): { trigger: HTMLElement; other: HTMLElement } {
  render(
    <div className="menu">
      <MenuExpander label="Open in">
        <button>VS Code</button>
      </MenuExpander>
      <button className="menu__item">Export</button>
    </div>
  )
  return {
    trigger: screen.getByRole('button', { name: 'Open in' }),
    other: screen.getByRole('button', { name: 'Export' })
  }
}

/** The card's first item, present only while the card is open. */
const card = (): HTMLElement | null => screen.queryByRole('button', { name: 'VS Code' })

describe('MenuExpander', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('keeps the nested options hidden until highlighted', () => {
    const { trigger } = setup()
    expect(card()).not.toBeInTheDocument()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('ignores a quick pass-through — opening waits for the hover-intent delay', () => {
    const { trigger } = setup()
    fireEvent.mouseEnter(trigger)
    act(() => vi.advanceTimersByTime(200)) // still under the threshold
    expect(card()).not.toBeInTheDocument()
    fireEvent.mouseLeave(trigger) // moved on — cancels the pending open
    act(() => vi.advanceTimersByTime(400))
    expect(card()).not.toBeInTheDocument()
  })

  it('opens a floating card to the side after resting on the row', () => {
    const { trigger } = setup()
    fireEvent.mouseEnter(trigger)
    act(() => vi.advanceTimersByTime(350))
    const item = card()
    expect(item).toBeInTheDocument()
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    const flyout = item?.closest('.menu--flyout') as HTMLElement
    expect(flyout).not.toBeNull()
    expect(flyout.style.position).toBe('fixed')
  })

  it('opens immediately on click, without the delay', () => {
    const { trigger } = setup()
    fireEvent.click(trigger)
    expect(card()).toBeInTheDocument()
  })

  it('closes at once when another row in the menu is hovered', () => {
    const { trigger, other } = setup()
    fireEvent.click(trigger)
    expect(card()).toBeInTheDocument()
    fireEvent.mouseOver(other)
    expect(card()).not.toBeInTheDocument()
  })

  it('stays open when the pointer crosses the menu chrome (not a row), for continuity', () => {
    render(
      <div className="menu">
        <MenuExpander label="Open in">
          <button>VS Code</button>
        </MenuExpander>
        <div className="menu__sep" data-testid="sep" />
      </div>
    )
    const trigger = screen.getByRole('button', { name: 'Open in' })
    fireEvent.click(trigger)
    expect(card()).toBeInTheDocument()
    fireEvent.mouseOver(screen.getByTestId('sep')) // menu chrome, not a .menu__item
    expect(card()).toBeInTheDocument()
  })

  it('closes after the grace delay once the pointer leaves entirely', () => {
    const { trigger } = setup()
    fireEvent.click(trigger)
    fireEvent.mouseLeave(trigger.parentElement as HTMLElement)
    expect(card()).toBeInTheDocument() // still open during the grace window
    act(() => vi.advanceTimersByTime(200))
    expect(card()).not.toBeInTheDocument()
  })

  it('toggles closed when the row is clicked while open', () => {
    const { trigger } = setup()
    fireEvent.click(trigger)
    expect(card()).toBeInTheDocument()
    fireEvent.click(trigger)
    expect(card()).not.toBeInTheDocument()
  })
})
