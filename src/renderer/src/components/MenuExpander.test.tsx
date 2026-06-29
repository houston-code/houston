import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { MenuExpander } from './MenuExpander'

function setup(): void {
  render(
    <MenuExpander label="Open in">
      <button>VS Code</button>
    </MenuExpander>
  )
}

describe('MenuExpander', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('keeps the nested options hidden until the row is highlighted', () => {
    setup()
    expect(screen.queryByRole('button', { name: 'VS Code' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open in' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('opens a floating card to the side on hover', () => {
    setup()
    const row = screen.getByRole('button', { name: 'Open in' })
    fireEvent.mouseEnter(row.parentElement as HTMLElement)
    expect(screen.getByRole('button', { name: 'VS Code' })).toBeInTheDocument()
    expect(row).toHaveAttribute('aria-expanded', 'true')
    // Options live in a labelled group styled as a floating card (fixed-positioned).
    const card = screen.getByRole('group', { name: 'Open in' })
    expect(card).toHaveClass('menu--flyout')
    expect(card.style.position).toBe('fixed')
  })

  it('closes shortly after the pointer leaves, not immediately', () => {
    setup()
    const wrap = screen.getByRole('button', { name: 'Open in' }).parentElement as HTMLElement
    fireEvent.mouseEnter(wrap)
    fireEvent.mouseLeave(wrap)
    // Still open during the bridge delay so the pointer can reach the card.
    expect(screen.getByRole('button', { name: 'VS Code' })).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(200))
    expect(screen.queryByRole('button', { name: 'VS Code' })).not.toBeInTheDocument()
  })

  it('toggles closed when the row is clicked while open', () => {
    setup()
    const row = screen.getByRole('button', { name: 'Open in' })
    fireEvent.click(row)
    expect(screen.getByRole('button', { name: 'VS Code' })).toBeInTheDocument()
    fireEvent.click(row)
    expect(screen.queryByRole('button', { name: 'VS Code' })).not.toBeInTheDocument()
  })
})
