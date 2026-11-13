import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { KeyHints, keyHintList } from './KeyHints'

describe('keyHintList', () => {
  it('lists the message-box characters and the bound shortcuts', () => {
    expect(keyHintList({ palette: '⌘K', cycleMode: '⇧Tab' })).toEqual([
      { keys: '/', does: 'commands' },
      { keys: '@', does: 'files' },
      { keys: '#', does: 'save a rule' },
      { keys: '⇧Tab', does: 'switch mode' },
      { keys: '↑', does: 'last prompt' },
      { keys: '⌘K', does: 'everything else' }
    ])
  })

  it('leaves out a shortcut the user unbound', () => {
    const does = keyHintList({ palette: '⌘K' }).map((h) => h.does)
    expect(does).not.toContain('switch mode')
    expect(keyHintList({}).map((h) => h.does)).toEqual(['commands', 'files', 'save a rule', 'last prompt'])
  })
})

describe('KeyHints', () => {
  it('shows each key beside what it does', () => {
    render(<KeyHints hints={keyHintList({ palette: 'Ctrl+K' })} />)
    const row = screen.getByLabelText('Keyboard hints')
    expect(row).toHaveTextContent('/ commands')
    expect(row).toHaveTextContent('Ctrl+K everything else')
    expect(row.querySelectorAll('kbd')).toHaveLength(5)
  })
})
