import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ToolItem } from '../lib/items'
import { ProposalCard, type ProposalHandlers } from './ProposalCard'

const item = (args: Record<string, unknown> = {}): ToolItem => ({
  kind: 'tool',
  id: 'p1',
  name: 'propose_session',
  args: { title: 'Update API docs', prompt: 'Document **/auth/***', ...args },
  status: 'done',
  output: 'Proposed "Update API docs" to the user as a card.'
})

function handlers(over: Partial<ProposalHandlers> = {}): ProposalHandlers {
  return {
    states: {},
    start: vi.fn(async () => {}),
    here: vi.fn(async () => {}),
    dismiss: vi.fn(async () => {}),
    open: vi.fn(),
    ...over
  }
}

describe('ProposalCard', () => {
  it('shows what would run and where, with the three choices', () => {
    render(<ProposalCard item={item()} handlers={handlers()} />)
    expect(screen.getByRole('group', { name: 'Proposed session: Update API docs' })).toBeInTheDocument()
    expect(screen.getByText('Proposed')).toBeInTheDocument()
    expect(screen.getByText(/On its own worktree in a git project · Starts fresh with its brief/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start session' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Do it here' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument()
  })

  it('names a requested branch and a forked context', () => {
    render(<ProposalCard item={item({ context: 'fork', worktree: { branch: 'docs/auth' } })} handlers={handlers()} />)
    expect(screen.getByText(/On branch docs\/auth · Gets a copy of this chat/)).toBeInTheDocument()
  })

  it('routes each choice to its handler', async () => {
    const h = handlers()
    render(<ProposalCard item={item()} handlers={h} />)
    fireEvent.click(screen.getByRole('button', { name: 'Do it here' }))
    await waitFor(() => expect(h.here).toHaveBeenCalledWith('p1', 'Update API docs', 'Document **/auth/***'))
    fireEvent.click(screen.getByRole('button', { name: 'Start session' }))
    await waitFor(() => expect(h.start).toHaveBeenCalledWith('p1'))
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(h.dismiss).toHaveBeenCalledWith('p1'))
  })

  it('shows a failed start inline and keeps the choices', async () => {
    const h = handlers({ start: vi.fn(async () => Promise.reject(new Error('Too many background sessions'))) })
    render(<ProposalCard item={item()} handlers={h} />)
    fireEvent.click(screen.getByRole('button', { name: 'Start session' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many background sessions')
    expect(screen.getByRole('button', { name: 'Start session' })).toBeEnabled()
  })

  it('once started, offers to open the session instead', () => {
    const h = handlers({ states: { p1: { status: 'started', conversationId: 'child', at: 1 } } })
    render(<ProposalCard item={item()} handlers={h} />)
    expect(screen.getByText('Started')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Start session' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open session' }))
    expect(h.open).toHaveBeenCalledWith('child')
  })

  it('shows a dismissed or asked-here card with no actions', () => {
    const { rerender } = render(
      <ProposalCard item={item()} handlers={handlers({ states: { p1: { status: 'dismissed', at: 1 } } })} />
    )
    expect(screen.getByText('Dismissed')).toBeInTheDocument()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    rerender(<ProposalCard item={item()} handlers={handlers({ states: { p1: { status: 'here', at: 1 } } })} />)
    expect(screen.getByText('Asked here')).toBeInTheDocument()
  })

  it('renders read-only without handlers', () => {
    render(<ProposalCard item={item()} />)
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })
})
