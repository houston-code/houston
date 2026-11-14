import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PANEL_NUDGE_STEP, PanelResizer } from './PanelResizer'

const size = (value: number) => ({ value, min: 100, max: 900, defaultValue: 420, onChange: vi.fn() })

describe('PanelResizer', () => {
  it('is a focusable separator carrying the size, nudged toward the arrow and reset by a double-click', () => {
    const s = size(500)
    render(<PanelResizer className="r" label="Resize side panel" edge="left" size={s} onMouseDown={vi.fn()} />)
    const sep = screen.getByRole('separator', { name: 'Resize side panel' })
    expect(sep).toHaveAttribute('tabindex', '0')
    expect(sep).toHaveAttribute('aria-valuenow', '500')
    expect(sep).toHaveAttribute('aria-valuemin', '100')
    expect(sep).toHaveAttribute('aria-valuemax', '900')
    // The edge is on the panel's left: moving it left widens the panel.
    fireEvent.keyDown(sep, { key: 'ArrowLeft' })
    expect(s.onChange).toHaveBeenLastCalledWith(500 + PANEL_NUDGE_STEP)
    fireEvent.keyDown(sep, { key: 'ArrowRight' })
    expect(s.onChange).toHaveBeenLastCalledWith(500 - PANEL_NUDGE_STEP)
    fireEvent.doubleClick(sep)
    expect(s.onChange).toHaveBeenLastCalledWith(420)
  })

  it('grows a bottom panel with ArrowUp', () => {
    const s = size(260)
    render(<PanelResizer className="r" label="Resize terminal panel" edge="top" size={s} onMouseDown={vi.fn()} />)
    const sep = screen.getByRole('separator', { name: 'Resize terminal panel' })
    expect(sep).toHaveAttribute('aria-orientation', 'horizontal')
    fireEvent.keyDown(sep, { key: 'ArrowUp' })
    expect(s.onChange).toHaveBeenLastCalledWith(260 + PANEL_NUDGE_STEP)
    fireEvent.keyDown(sep, { key: 'ArrowLeft' })
    expect(s.onChange).toHaveBeenCalledTimes(1)
  })
})
