import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TurnErrorBar } from './TurnErrorBar'

describe('TurnErrorBar', () => {
  it('explains a bad key and offers the provider settings, the doctor and a retry', () => {
    const onAction = vi.fn()
    render(<TurnErrorBar failure={{ message: 'invalid x-api-key', cause: 'auth' }} onAction={onAction} />)
    expect(screen.getByText('The provider did not accept the API key, or none is set.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open provider settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Run the doctor' }))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onAction.mock.calls.map((c) => c[0])).toEqual(['provider-settings', 'doctor', 'retry'])
  })

  it('keeps the raw message one click away', () => {
    render(<TurnErrorBar failure={{ message: '529 Overloaded', cause: 'provider-down' }} onAction={vi.fn()} />)
    expect(screen.queryByText('529 Overloaded')).toBeNull()
    const details = screen.getByRole('button', { name: 'Details' })
    fireEvent.click(details)
    expect(screen.getByText('529 Overloaded')).toBeInTheDocument()
    expect(details).toHaveAttribute('aria-expanded', 'true')
  })

  it('always offers a retry, even where the cause suggests something else first', () => {
    render(<TurnErrorBar failure={{ message: 'x', cause: 'tools-unsupported' }} onAction={vi.fn()} />)
    const names = screen.getAllByRole('button').map((b) => b.textContent?.trim())
    expect(names).toEqual(['Switch model', 'Retry', 'Details'])
  })

  it('falls back to a generic line when nothing is known about the failure', () => {
    render(<TurnErrorBar failure={null} onAction={vi.fn()} />)
    expect(screen.getByText('The last turn failed.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Details' })).toBeNull()
  })
})
