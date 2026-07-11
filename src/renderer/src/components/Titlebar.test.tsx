import { fireEvent, render, screen, within } from '@testing-library/react'
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

describe('Titlebar icon-only actions', () => {
  it('labels each action for screen readers and shows a descriptive tooltip on hover', () => {
    render(
      <Titlebar
        title="Houston"
        onTogglePreview={vi.fn()}
        onShowFiles={vi.fn()}
        onShowChanges={vi.fn()}
        onToggleTerminal={vi.fn()}
      />
    )
    // Buttons render icon-only: the accessible name comes from aria-label, while a
    // shared custom tooltip (role="tooltip") appears on hover — no native `title`,
    // which is slow and can't be styled or made instant between buttons.
    for (const [name, tip] of [
      ['Preview', /toggle the live preview panel/i],
      ['Files', /browse the project's files/i],
      ['Changes', /uncommitted/i],
      ['Terminal', /integrated terminal/i]
    ] as const) {
      const btn = screen.getByRole('button', { name })
      // No visible text label — the button holds only its inline SVG icon.
      expect(btn.textContent).toBe('')
      expect(btn).not.toHaveAttribute('title')
      fireEvent.mouseEnter(btn)
      expect(screen.getByRole('tooltip')).toHaveTextContent(tip)
      fireEvent.mouseLeave(btn)
    }
  })

  it('shows the changed-file count as a badge and folds +/− into the tooltip', () => {
    render(
      <Titlebar
        title="Houston"
        onShowChanges={vi.fn()}
        changes={{ fileCount: 3, added: 12, removed: 4 }}
      />
    )
    const btn = screen.getByRole('button', { name: 'Changes' })
    expect(within(btn).getByText('3')).toBeInTheDocument()
    fireEvent.mouseEnter(btn)
    expect(screen.getByRole('tooltip')).toHaveTextContent('+12 −4')
    // Dirty state is signalled by the badge alone — no accent outline (that's
    // reserved for open docked panels like Preview and Terminal).
    expect(btn.className).toBe('titlebar__action')
  })

  it('omits the changes badge when the working tree is clean', () => {
    render(
      <Titlebar
        title="Houston"
        onShowChanges={vi.fn()}
        changes={{ fileCount: 0, added: 0, removed: 0 }}
      />
    )
    const btn = screen.getByRole('button', { name: 'Changes' })
    expect(within(btn).queryByText(/^\d+$/)).not.toBeInTheDocument()
  })
})
