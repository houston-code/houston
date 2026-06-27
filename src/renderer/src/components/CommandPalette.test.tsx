import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CommandPalette } from './CommandPalette'
import type { PaletteItem } from '../lib/palette'

const makeItems = (): { items: PaletteItem[]; runs: Record<string, ReturnType<typeof vi.fn>> } => {
  const runs = {
    new: vi.fn(),
    settings: vi.fn(),
    plan: vi.fn(),
    chat: vi.fn()
  }
  const items: PaletteItem[] = [
    { id: 'new', title: 'New chat', section: 'Actions', run: runs.new },
    { id: 'settings', title: 'Open settings', section: 'Actions', run: runs.settings },
    { id: 'plan', title: 'Plan mode', section: 'Approval', hint: '⌘.', run: runs.plan },
    { id: 'chat', title: 'Fix login bug', section: 'Switch chat', subtitle: 'acme-web', run: runs.chat }
  ]
  return { items, runs }
}

describe('CommandPalette', () => {
  it('renders all items grouped by section', () => {
    const { items } = makeItems()
    render(<CommandPalette items={items} onClose={() => {}} />)
    expect(screen.getByText('Actions')).toBeInTheDocument()
    expect(screen.getByText('Approval')).toBeInTheDocument()
    expect(screen.getByText('New chat')).toBeInTheDocument()
    expect(screen.getByText('Fix login bug')).toBeInTheDocument()
  })

  it('filters as the user types', () => {
    const { items } = makeItems()
    render(<CommandPalette items={items} onClose={() => {}} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'login' } })
    expect(screen.getByText('Fix login bug')).toBeInTheDocument()
    expect(screen.queryByText('New chat')).not.toBeInTheDocument()
  })

  it('runs the item and closes on Enter', () => {
    const { items, runs } = makeItems()
    const onClose = vi.fn()
    render(<CommandPalette items={items} onClose={onClose} />)
    const input = screen.getByRole('combobox')
    fireEvent.change(input, { target: { value: 'settings' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(runs.settings).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('runs the item on click', () => {
    const { items, runs } = makeItems()
    const onClose = vi.fn()
    render(<CommandPalette items={items} onClose={onClose} />)
    fireEvent.mouseDown(screen.getByText('Plan mode'))
    expect(runs.plan).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('moves the active row with the arrow keys and wraps', () => {
    const { items, runs } = makeItems()
    render(<CommandPalette items={items} onClose={() => {}} />)
    const input = screen.getByRole('combobox')
    // First item active by default; Up wraps to the last item.
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(runs.chat).toHaveBeenCalledOnce()
  })

  it('shows an empty state and Enter is a no-op when nothing matches', () => {
    const { items, runs } = makeItems()
    render(<CommandPalette items={items} onClose={() => {}} />)
    const input = screen.getByRole('combobox')
    fireEvent.change(input, { target: { value: 'zzzzz' } })
    expect(screen.getByText('No matching commands')).toBeInTheDocument()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(Object.values(runs).every((r) => r.mock.calls.length === 0)).toBe(true)
  })

  it('closes on backdrop click but not when the dialog is clicked', () => {
    const { items } = makeItems()
    const onClose = vi.fn()
    const { container } = render(<CommandPalette items={items} onClose={onClose} />)
    fireEvent.click(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(container.querySelector('.modal-backdrop') as HTMLElement)
    expect(onClose).toHaveBeenCalledOnce()
  })
})
