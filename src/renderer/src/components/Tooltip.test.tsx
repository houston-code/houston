import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Tooltip, TooltipProvider } from './Tooltip'

/** Two tooltip'd buttons under one provider — the real titlebar arrangement. */
function Harness(): JSX.Element {
  return (
    <TooltipProvider>
      <Tooltip label="Files: browse files">
        <button type="button" aria-label="Files">
          F
        </button>
      </Tooltip>
      <Tooltip label="Terminal: toggle terminal">
        <button type="button" aria-label="Terminal">
          T
        </button>
      </Tooltip>
    </TooltipProvider>
  )
}

afterEach(() => vi.useRealTimers())

describe('Tooltip', () => {
  it('shows a tooltip with the label on hover; none before', () => {
    render(<Harness />)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Files' }))
    expect(screen.getByRole('tooltip')).toHaveTextContent('Files: browse files')
  })

  it('keeps the trigger clickable and preserves its own props', () => {
    const onClick = vi.fn()
    render(
      <TooltipProvider>
        <Tooltip label="tip">
          <button type="button" aria-label="Go" onClick={onClick}>
            G
          </button>
        </Tooltip>
      </TooltipProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Go' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('reuses a single shared tooltip element as the pointer moves between buttons', () => {
    render(<Harness />)
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Files' }))
    fireEvent.mouseLeave(screen.getByRole('button', { name: 'Files' }))
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Terminal' }))
    const tips = screen.getAllByRole('tooltip')
    expect(tips).toHaveLength(1)
    expect(tips[0]).toHaveTextContent('Terminal: toggle terminal')
  })

  it('delays the first show, then shows a neighbour instantly within the skip window', () => {
    vi.useFakeTimers()
    render(<Harness />)
    const files = screen.getByRole('button', { name: 'Files' })
    // Present immediately, but only faded in (`tt--shown`) after the open delay.
    act(() => {
      fireEvent.mouseEnter(files)
    })
    expect(screen.getByRole('tooltip')).not.toHaveClass('tt--shown')
    act(() => vi.advanceTimersByTime(60))
    expect(screen.getByRole('tooltip')).toHaveClass('tt--shown')
    // Leave (let the hide grace fire), then hover the neighbour right away: it
    // shows with no second delay — the smooth part of "instant yet smooth".
    act(() => {
      fireEvent.mouseLeave(files)
      vi.advanceTimersByTime(60)
    })
    act(() => {
      fireEvent.mouseEnter(screen.getByRole('button', { name: 'Terminal' }))
    })
    expect(screen.getByRole('tooltip')).toHaveClass('tt--shown')
  })

  it('dismisses an already-shown tooltip when its trigger becomes disabled', () => {
    vi.useFakeTimers()
    const view = (disabled: boolean): JSX.Element => (
      <TooltipProvider>
        <Tooltip label="Background tasks" disabled={disabled}>
          <button type="button" aria-label="BG">
            B
          </button>
        </Tooltip>
      </TooltipProvider>
    )
    const { rerender } = render(view(false))
    act(() => {
      fireEvent.mouseEnter(screen.getByRole('button', { name: 'BG' }))
    })
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    // The button's popover opens → disabled flips true → the tip is dismissed even
    // though the pointer never left the button.
    rerender(view(true))
    act(() => vi.advanceTimersByTime(60))
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('skips the tooltip entirely when disabled', () => {
    render(
      <TooltipProvider>
        <Tooltip label="Hidden" disabled>
          <button type="button" aria-label="Nope">
            N
          </button>
        </Tooltip>
      </TooltipProvider>
    )
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Nope' }))
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('renders the child untouched and never throws outside a provider', () => {
    render(
      <Tooltip label="x">
        <button type="button" aria-label="Solo">
          S
        </button>
      </Tooltip>
    )
    const btn = screen.getByRole('button', { name: 'Solo' })
    fireEvent.mouseEnter(btn)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })
})
