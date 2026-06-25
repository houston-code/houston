import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Command } from '@shared/commands'
import { Composer } from './Composer'

const COMMANDS: Command[] = [
  { name: 'new', description: 'Start a new chat' },
  { name: 'plan', description: 'Plan mode' }
]

function baseProps(overrides: Partial<Parameters<typeof Composer>[0]> = {}) {
  return {
    disabled: false,
    running: false,
    workspace: null,
    commands: COMMANDS,
    vision: true,
    onCommand: vi.fn(),
    onSend: vi.fn(),
    onCancel: vi.fn(),
    ...overrides
  }
}

function type(value: string): HTMLTextAreaElement {
  const input = screen.getByRole('textbox') as HTMLTextAreaElement
  fireEvent.change(input, { target: { value } })
  return input
}

describe('Composer', () => {
  it('runs a slash command (not a send) when idle', () => {
    const props = baseProps()
    render(<Composer {...props} />)

    // Trailing space closes the command menu so Enter submits the command.
    const input = type('/new ')
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(props.onCommand).toHaveBeenCalledWith(expect.objectContaining({ name: 'new' }), '')
    expect(props.onSend).not.toHaveBeenCalled()
  })

  it('queues a message via Enter while a run is in progress', () => {
    const props = baseProps({ running: true })
    render(<Composer {...props} />)

    const input = type('follow-up work')
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(props.onSend).toHaveBeenCalledWith('follow-up work', undefined)
    expect(input.value).toBe('') // composer clears after queuing
  })

  it('queues slash-command text verbatim while running (no command runs)', () => {
    const props = baseProps({ running: true })
    render(<Composer {...props} />)

    const input = type('/new')
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(props.onSend).toHaveBeenCalledWith('/new', undefined)
    expect(props.onCommand).not.toHaveBeenCalled()
  })

  it('shows Queue and Stop while running, and Send when idle', () => {
    const { rerender } = render(<Composer {...baseProps({ running: true })} />)
    expect(screen.getByRole('button', { name: 'Queue' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument()

    rerender(<Composer {...baseProps({ running: false })} />)
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Queue' })).not.toBeInTheDocument()
  })

  it('queues via the Queue button click while running', () => {
    const props = baseProps({ running: true })
    render(<Composer {...props} />)

    type('click queue')
    fireEvent.click(screen.getByRole('button', { name: 'Queue' }))

    expect(props.onSend).toHaveBeenCalledWith('click queue', undefined)
  })

  it('Stop cancels the run', () => {
    const props = baseProps({ running: true })
    render(<Composer {...props} />)

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(props.onCancel).toHaveBeenCalledOnce()
  })
})
