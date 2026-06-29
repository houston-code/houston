import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Command } from '@shared/commands'
import { Composer } from './Composer'

const COMMANDS: Command[] = [
  { name: 'new', description: 'Start a new chat' },
  { name: 'plan', description: 'Plan mode' }
]

function baseProps(overrides: Partial<Parameters<typeof Composer>[0]> = {}) {
  return {
    conversationId: null,
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

// The composer seeds itself from the persisted draft on mount, so keep storage
// clean between tests to avoid one test's draft leaking into the next.
beforeEach(() => localStorage.clear())

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

describe('Composer slash-command templates', () => {
  it('runs an autoRun template command immediately instead of expanding it', () => {
    const review: Command = {
      name: 'review',
      description: 'Review',
      autoRun: true,
      template: 'Do the review now.'
    }
    const props = baseProps({ commands: [review] })
    render(<Composer {...props} />)

    // Trailing space closes the command menu so Enter submits (matches /new).
    const input = type('/review ')
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(props.onSend).toHaveBeenCalledWith('Do the review now.')
    expect(input.value).toBe('') // sent, not left lingering in the field
  })

  it('expands a non-autoRun template command into the field for editing', () => {
    const custom: Command = {
      name: 'spec',
      description: 'Spec',
      template: 'Write a spec for $ARGUMENTS.'
    }
    const props = baseProps({ commands: [custom] })
    render(<Composer {...props} />)

    const input = type('/spec the login flow')
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(props.onSend).not.toHaveBeenCalled()
    expect(input.value).toBe('Write a spec for the login flow.') // previewed for editing
  })
})

describe('Composer prompt-history recall', () => {
  beforeEach(() => localStorage.clear())

  const sendPrompt = (text: string): void => {
    const input = type(text)
    fireEvent.keyDown(input, { key: 'Enter' })
  }

  it('recalls previous prompts with Up (newest first) and walks back/forward', () => {
    render(<Composer {...baseProps()} />)
    sendPrompt('first prompt')
    sendPrompt('second prompt')

    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(input.value).toBe('') // cleared after sending

    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input.value).toBe('second prompt')
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input.value).toBe('first prompt')
    // Clamps at the oldest.
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input.value).toBe('first prompt')

    // Down walks forward, then restores the (empty) draft past the newest.
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input.value).toBe('second prompt')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input.value).toBe('')
  })

  it('does not recall when the field already has a draft (Up moves the caret instead)', () => {
    render(<Composer {...baseProps()} />)
    sendPrompt('history entry')

    const input = type('half-written')
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input.value).toBe('half-written') // untouched
  })

  it('does nothing on Up when there is no history', () => {
    render(<Composer {...baseProps()} />)
    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input.value).toBe('')
  })
})

describe('Composer edit-last-message (Esc Esc)', () => {
  it('recalls the last user message on double-Esc when the field is empty', () => {
    render(<Composer {...baseProps({ lastUserMessage: 'the previous question' })} />)
    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.keyDown(input, { key: 'Escape' })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input.value).toBe('the previous question')
  })

  it('does not recall on a single Esc', () => {
    render(<Composer {...baseProps({ lastUserMessage: 'the previous question' })} />)
    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input.value).toBe('')
  })

  it('leaves a non-empty draft untouched on double-Esc', () => {
    render(<Composer {...baseProps({ lastUserMessage: 'the previous question' })} />)
    const input = type('half-written thought')
    fireEvent.keyDown(input, { key: 'Escape' })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input.value).toBe('half-written thought')
  })

  it('is a no-op when there is no last message', () => {
    render(<Composer {...baseProps()} />)
    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.keyDown(input, { key: 'Escape' })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input.value).toBe('')
  })
})

describe('Composer draft persistence', () => {
  it('restores a conversation’s unsent draft after a restart (unmount + remount)', () => {
    const { unmount } = render(<Composer {...baseProps({ conversationId: 'c1' })} />)
    type('a half-written message')
    unmount() // simulate quitting the app

    render(<Composer {...baseProps({ conversationId: 'c1' })} />)
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(
      'a half-written message'
    )
  })

  it('keeps drafts isolated per conversation', () => {
    const first = render(<Composer {...baseProps({ conversationId: 'c1' })} />)
    type('draft for chat one')
    first.unmount()

    // A different conversation starts empty — chat one's draft doesn't leak in…
    const second = render(<Composer {...baseProps({ conversationId: 'c2' })} />)
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('')
    type('draft for chat two')
    second.unmount()

    // …and each chat restores its own draft, independently.
    const backToOne = render(<Composer {...baseProps({ conversationId: 'c1' })} />)
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('draft for chat one')
    backToOne.unmount()

    render(<Composer {...baseProps({ conversationId: 'c2' })} />)
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('draft for chat two')
  })

  it('clears the persisted draft once the message is sent', () => {
    const { unmount } = render(<Composer {...baseProps({ conversationId: 'c1' })} />)
    const input = type('send me')
    fireEvent.keyDown(input, { key: 'Enter' })
    unmount()

    render(<Composer {...baseProps({ conversationId: 'c1' })} />)
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('')
  })
})
