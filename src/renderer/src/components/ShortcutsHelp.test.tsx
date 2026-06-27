import { render, screen, fireEvent, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ShortcutsHelp } from './ShortcutsHelp'

/** The self-documenting "Keyboard shortcuts" row label (not the dialog's <h2> title). */
const helpRow = (): HTMLElement =>
  screen.getByText(
    (_t, el) => el?.classList.contains('shortcuts-help__label') === true && el.textContent === 'Keyboard shortcuts'
  )

describe('ShortcutsHelp', () => {
  it('renders as a labelled modal dialog', () => {
    render(<ShortcutsHelp onClose={() => {}} />)
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByRole('heading', { name: /keyboard shortcuts/i })).toBeInTheDocument()
  })

  it('lists known shortcuts grouped under their category', () => {
    render(<ShortcutsHelp onClose={() => {}} />)
    expect(screen.getByRole('heading', { name: 'General' })).toBeInTheDocument()
    expect(screen.getByText('New chat')).toBeInTheDocument()
    expect(screen.getByText('Toggle sidebar')).toBeInTheDocument()
    // The help entry documents itself — it's the row label, not the dialog title.
    expect(helpRow()).toBeInTheDocument()
  })

  it('shows both chords for a multi-chord shortcut', () => {
    render(<ShortcutsHelp onClose={() => {}} />)
    const row = helpRow().closest('li') as HTMLElement
    // ⌘/ or ? — two <kbd> hints joined by "or".
    expect(within(row).getAllByText((_t, el) => el?.tagName === 'KBD').length).toBe(2)
    expect(within(row).getByText('or')).toBeInTheDocument()
  })

  it('closes on the X button and on backdrop click', () => {
    const onClose = vi.fn()
    const { container } = render(<ShortcutsHelp onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(container.querySelector('.modal-backdrop') as HTMLElement)
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('does not close when the dialog body is clicked', () => {
    const onClose = vi.fn()
    render(<ShortcutsHelp onClose={onClose} />)
    fireEvent.click(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()
  })
})
