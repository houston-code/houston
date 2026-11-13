import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { PinnedTodos } from './PinnedTodos'

afterEach(cleanup)

const todos = [
  { content: 'Read the code', status: 'completed' as const },
  { content: 'Write the fix', status: 'in_progress' as const },
  { content: 'Run the tests', status: 'pending' as const }
]

describe('PinnedTodos', () => {
  it('shows progress and the item in progress, collapsed', () => {
    render(<PinnedTodos todos={todos} />)
    expect(screen.getByText('1 of 3 done')).toBeTruthy()
    expect(screen.getByText('Write the fix')).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false')
  })

  it('expands to the whole list with each state named for screen readers', () => {
    render(<PinnedTodos todos={todos} />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('true')
    const items = screen.getAllByRole('listitem').map((li) => li.textContent)
    expect(items).toEqual(['●Read the code (done)', '◐Write the fix (in progress)', '○Run the tests'])
  })
})
