import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RewindPicker } from './RewindPicker'

const targets = [
  { turn: 0, text: 'first', label: 'first' },
  { turn: 1, text: 'second', label: 'second' },
  { turn: 2, text: 'third', label: 'third' }
]

describe('RewindPicker', () => {
  it('lists the messages newest first, numbered', () => {
    render(<RewindPicker targets={targets} onPick={vi.fn()} onClose={vi.fn()} />)
    const options = screen.getAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual(['3third', '2second', '1first'])
    expect(options[0].getAttribute('aria-selected')).toBe('true')
  })

  it('moves with the arrow keys and picks with Enter', () => {
    const onPick = vi.fn()
    render(<RewindPicker targets={targets} onPick={onPick} onClose={vi.fn()} />)
    const dialog = screen.getByRole('dialog')
    fireEvent.keyDown(dialog, { key: 'ArrowDown' })
    fireEvent.keyDown(dialog, { key: 'ArrowDown' })
    fireEvent.keyDown(dialog, { key: 'Enter' })
    expect(onPick).toHaveBeenCalledWith(targets[0])
    fireEvent.keyDown(dialog, { key: 'ArrowUp' })
    fireEvent.keyDown(dialog, { key: 'Enter' })
    expect(onPick).toHaveBeenLastCalledWith(targets[1])
  })

  it('picks on click and closes on Escape', () => {
    const onPick = vi.fn()
    const onClose = vi.fn()
    render(<RewindPicker targets={targets} onPick={onPick} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /second/ }))
    expect(onPick).toHaveBeenCalledWith(targets[1])
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('says so when there is nothing to rewind to', () => {
    render(<RewindPicker targets={[]} onPick={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByText('No earlier messages to rewind to yet.')).toBeTruthy()
  })
})
