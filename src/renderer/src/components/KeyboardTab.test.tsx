import { render, screen, fireEvent, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { KeyboardTab } from './SettingsModal'

const noop = (): void => {}

/** The `.keybind-row` element whose label matches `label`. */
function row(label: string): HTMLElement {
  return screen.getByText(label).closest('.keybind-row') as HTMLElement
}

/** The capture button (current binding / "Press keys…") within a row. */
function capture(label: string): HTMLElement {
  return row(label).querySelector('.keybind-row__capture') as HTMLElement
}

describe('KeyboardTab', () => {
  it('lists rebindable shortcuts but not fixed/composer ones', () => {
    render(<KeyboardTab overrides={undefined} onSet={noop} onReset={noop} onResetAll={noop} />)
    expect(screen.getByText('New chat')).toBeInTheDocument()
    expect(screen.getByText('Command palette')).toBeInTheDocument()
    // Escape (fixed) and composer-only shortcuts (send/newline) aren't customizable.
    expect(screen.queryByText('Send message')).not.toBeInTheDocument()
    expect(
      screen.queryByText('Stop the current turn, or close an open dialog')
    ).not.toBeInTheDocument()
  })

  it('records a new binding for a shortcut (normalising ⌘/Ctrl to mod)', () => {
    const onSet = vi.fn()
    render(<KeyboardTab overrides={undefined} onSet={onSet} onReset={noop} onResetAll={noop} />)
    fireEvent.click(capture('New chat')) // start recording
    expect(capture('New chat')).toHaveTextContent('Press keys…')
    fireEvent.keyDown(capture('New chat'), { key: 'j', metaKey: true })
    expect(onSet).toHaveBeenCalledWith('new-chat', 'mod+j')
  })

  it('ignores a bare modifier press while recording', () => {
    const onSet = vi.fn()
    render(<KeyboardTab overrides={undefined} onSet={onSet} onReset={noop} onResetAll={noop} />)
    fireEvent.click(capture('Command palette'))
    fireEvent.keyDown(capture('Command palette'), { key: 'Shift', shiftKey: true })
    expect(onSet).not.toHaveBeenCalled()
    expect(capture('Command palette')).toHaveTextContent('Press keys…') // still recording
  })

  it('shows the override binding plus Reset/Disable, and fires the callbacks', () => {
    const onSet = vi.fn()
    const onReset = vi.fn()
    render(
      <KeyboardTab
        overrides={{ 'new-chat': 'mod+j' }}
        onSet={onSet}
        onReset={onReset}
        onResetAll={noop}
      />
    )
    expect(capture('New chat')).toHaveTextContent(/⌘J|Ctrl\+J/)
    const controls = row('New chat')
    fireEvent.click(within(controls).getByRole('button', { name: 'Disable' }))
    expect(onSet).toHaveBeenCalledWith('new-chat', null)
    fireEvent.click(within(controls).getByRole('button', { name: 'Reset' }))
    expect(onReset).toHaveBeenCalledWith('new-chat')
  })

  it('shows an Unbound, disabled shortcut without a Disable button', () => {
    render(
      <KeyboardTab
        overrides={{ 'toggle-sidebar': null }}
        onSet={noop}
        onReset={noop}
        onResetAll={noop}
      />
    )
    expect(capture('Toggle sidebar')).toHaveTextContent('Unbound')
    expect(within(row('Toggle sidebar')).queryByRole('button', { name: 'Disable' })).toBeNull()
  })

  it('offers Reset all only when there are overrides', () => {
    const onResetAll = vi.fn()
    const { rerender } = render(
      <KeyboardTab overrides={undefined} onSet={noop} onReset={noop} onResetAll={onResetAll} />
    )
    expect(screen.queryByRole('button', { name: /reset all/i })).not.toBeInTheDocument()
    rerender(
      <KeyboardTab
        overrides={{ 'new-chat': 'mod+j' }}
        onSet={noop}
        onReset={noop}
        onResetAll={onResetAll}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /reset all/i }))
    expect(onResetAll).toHaveBeenCalledTimes(1)
  })
})
