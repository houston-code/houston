import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ChoiceMenu, type Choice } from './ChoiceMenu'

const choices: Choice<'a' | 'b' | 'c'>[] = [
  { value: 'a', label: 'Alpha', hint: 'First thing.' },
  { value: 'b', label: 'Beta', hint: 'Second thing.' },
  { value: 'c', label: 'Gamma', hint: 'Third thing.' }
]

function setup(value: 'a' | 'b' | 'c' = 'b', disabled = false) {
  const onChange = vi.fn()
  render(<ChoiceMenu value={value} choices={choices} onChange={onChange} ariaLabel="Pick one" disabled={disabled} />)
  return { onChange, trigger: screen.getByRole('combobox', { name: 'Pick one' }) }
}

describe('ChoiceMenu', () => {
  it('shows the current choice on the trigger and stays closed until asked', () => {
    const { trigger } = setup()
    expect(trigger).toHaveTextContent('Beta')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('lists each option with its hint, marks the current one, and focuses it', () => {
    const { trigger } = setup()
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    const list = screen.getByRole('listbox', { name: 'Pick one' })
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'AlphaFirst thing.',
      '✓BetaSecond thing.',
      'GammaThird thing.'
    ])
    const selected = within(list).getByRole('option', { selected: true })
    expect(selected).toHaveTextContent('Beta')
    expect(selected).toHaveFocus()
  })

  it('reports a new pick, closes, and returns focus to the trigger', () => {
    const { onChange, trigger } = setup()
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('option', { name: /^Gamma/ }))
    expect(onChange).toHaveBeenCalledExactlyOnceWith('c')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(trigger).toHaveFocus()
  })

  it('does not report a pick of the value already chosen', () => {
    const { onChange, trigger } = setup()
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('option', { name: /Beta/ }))
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('opens from the keyboard and moves between options with the arrows', () => {
    const { trigger } = setup('a')
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    const options = screen.getAllByRole('option')
    expect(options[0]).toHaveFocus()
    fireEvent.keyDown(document, { key: 'ArrowDown' })
    expect(options[1]).toHaveFocus()
    fireEvent.keyDown(document, { key: 'ArrowUp' })
    fireEvent.keyDown(document, { key: 'ArrowUp' })
    expect(options[2]).toHaveFocus()
  })

  it('closes on Escape without changing anything', () => {
    const { onChange, trigger } = setup()
    fireEvent.click(trigger)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('cannot be opened while disabled', () => {
    const { trigger } = setup('a', true)
    expect(trigger).toBeDisabled()
    fireEvent.click(trigger)
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})
