import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TerminalChip } from './TerminalChip'

describe('TerminalChip', () => {
  it('shows the tab count while the panel is hidden and reopens it on click', () => {
    const onShow = vi.fn()
    render(<TerminalChip tabCount={2} open={false} shortcut="⌃`" onShow={onShow} />)
    const chip = screen.getByRole('button', { name: 'Show terminal, 2 tabs' })
    expect(chip).toHaveTextContent('Terminal · 2')
    fireEvent.click(chip)
    expect(onShow).toHaveBeenCalledTimes(1)
  })

  it('names a single tab in the singular', () => {
    render(<TerminalChip tabCount={1} open={false} onShow={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Show terminal, 1 tab' })).toBeInTheDocument()
  })

  it('renders nothing while the panel is open', () => {
    const { container } = render(<TerminalChip tabCount={2} open onShow={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when no terminal is open', () => {
    const { container } = render(<TerminalChip tabCount={0} open={false} onShow={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })
})
