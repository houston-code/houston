import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ElicitationItem } from '../lib/items'
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
})
