import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { elicitationOutcome, type ElicitationItem } from '../lib/items'
import { ElicitationCard } from './ElicitationCard'

const item: ElicitationItem = {
  kind: 'elicitation',
  id: 'e1',
  serverId: 'deploy',
  message: 'Which environment?',
  fields: [{ name: 'env', kind: 'string', required: true }]
}

describe('ElicitationCard', () => {
  it('announces why a submit was refused, and sends nothing', () => {
    const onResolve = vi.fn()
    render(<ElicitationCard item={item} onResolve={onResolve} />)
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(screen.getByRole('alert')).toHaveTextContent('"env" is required.')
    expect(onResolve).not.toHaveBeenCalled()
  })

  it('offers Cancel next to Decline, and each sends its own answer', () => {
    const onResolve = vi.fn()
    render(<ElicitationCard item={item} onResolve={onResolve} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onResolve).toHaveBeenLastCalledWith('e1', { action: 'cancel' })
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }))
    expect(onResolve).toHaveBeenLastCalledWith('e1', { action: 'decline' })
  })

  it('shows a cancelled request as Cancelled', () => {
    render(<ElicitationCard item={{ ...item, outcome: elicitationOutcome('cancel') }} onResolve={vi.fn()} />)
    expect(screen.getByText('Cancelled')).toBeInTheDocument()
    expect(elicitationOutcome('accept')).toBe('accepted')
    expect(elicitationOutcome('decline')).toBe('declined')
  })
})
