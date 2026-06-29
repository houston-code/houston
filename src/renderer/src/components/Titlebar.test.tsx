import { fireEvent, render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { Titlebar } from './Titlebar'

describe('Titlebar preview button', () => {
  it('toggles the preview panel and reflects the open state', () => {
    const onTogglePreview = vi.fn()
    render(<Titlebar title="Houston" onTogglePreview={onTogglePreview} previewOpen={true} />)
    const btn = screen.getByRole('button', { name: /preview/i })
    expect(btn).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(btn)
    expect(onTogglePreview).toHaveBeenCalledTimes(1)
  })

  it('shows a count badge only when servers are running', () => {
    const { rerender } = render(
      <Titlebar title="Houston" onTogglePreview={vi.fn()} previewCount={0} />
    )
    expect(screen.queryByText('2')).not.toBeInTheDocument()
    rerender(<Titlebar title="Houston" onTogglePreview={vi.fn()} previewCount={2} />)
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('omits the preview button when no handler is given', () => {
    render(<Titlebar title="Houston" />)
    expect(screen.queryByRole('button', { name: /preview/i })).not.toBeInTheDocument()
  })
})
