import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ULTRATHINK_HINT, ULTRATHINK_HINT_ALREADY, ULTRATHINK_HINT_NONE } from '@shared/ultrathink'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
    onInvoke: vi.fn(),
    onSteer: vi.fn(),
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

describe('Composer tool buttons', () => {
  it('explain themselves in a tooltip as well as their accessible name', () => {
    render(<Composer {...baseProps()} />)
    expect(screen.getByRole('button', { name: 'Add attachment' })).toHaveAttribute(
      'title',
      'Add a file, image or link'
    )
    expect(screen.getByRole('button', { name: 'Attach image' })).toHaveAttribute(
      'title',
      expect.stringContaining('paste or drop')
    )
    expect(screen.getByRole('button', { name: 'Reference a file' })).toHaveAttribute(
      'title',
      expect.stringContaining('type @')
    )
  })
})

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

  it('routes /agent to onCommand with its args (the dispatch happens in App)', () => {
    const agent: Command = { name: 'agent', description: 'Dispatch an agent' }
    const props = baseProps({ commands: [agent] })
    render(<Composer {...props} />)
    // Trailing content after the name keeps the menu closed so Enter submits.
    const input = type('/agent reviewer check the diff')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(props.onCommand).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'agent' }),
      'reviewer check the diff'
    )
    expect(props.onSend).not.toHaveBeenCalled()
  })

  it('runs a fully-typed command on Enter without needing a second Enter', () => {
    const props = baseProps()
    render(<Composer {...props} />)

    // No trailing space: the menu is open and "new" is fully typed.
    const input = type('/new')
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(props.onCommand).toHaveBeenCalledWith(expect.objectContaining({ name: 'new' }), '')
  })

  it('does not submit on the Enter that confirms an IME composition', () => {
    const props = baseProps()
    render(<Composer {...props} />)

    const input = type('こんにちは')
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    expect(props.onSend).not.toHaveBeenCalled()

    // The Enter that ends composition sends normally.
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(props.onSend).toHaveBeenCalledWith('こんにちは', undefined)
  })

  it('runs a ! line in the terminal instead of sending it', () => {
    const onShellEscape = vi.fn()
    const props = baseProps({ onShellEscape })
    render(<Composer {...props} />)
    const input = type('!npm test')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onShellEscape).toHaveBeenCalledWith('npm test')
    expect(props.onSend).not.toHaveBeenCalled()
    expect(input.value).toBe('')
  })

  it('sends a ! line as a message when nothing runs it', () => {
    const props = baseProps()
    render(<Composer {...props} />)
    fireEvent.keyDown(type('!npm test'), { key: 'Enter' })
    expect(props.onSend).toHaveBeenCalledWith('!npm test', undefined)
  })

  it('sends a lone ! as ordinary text', () => {
    const onShellEscape = vi.fn()
    const props = baseProps({ onShellEscape })
    render(<Composer {...props} />)
    fireEvent.keyDown(type('!'), { key: 'Enter' })
    expect(onShellEscape).not.toHaveBeenCalled()
    expect(props.onSend).toHaveBeenCalledWith('!', undefined)
  })

  it('answers a terminal-only command instead of sending it to the model', () => {
    const props = baseProps()
    render(<Composer {...props} />)
    const input = type('/vim')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(props.onSend).not.toHaveBeenCalled()
    expect(props.onCommand).not.toHaveBeenCalled()
    expect(screen.getByText(/\/vim is a terminal command/)).toBeInTheDocument()
  })

  it('runs a command typed by its terminal alias', () => {
    const changes: Command = { name: 'changes', description: 'What changed' }
    const props = baseProps({ commands: [changes] })
    render(<Composer {...props} />)
    const input = type('/diff ')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(props.onCommand).toHaveBeenCalledWith(expect.objectContaining({ name: 'changes' }), '')
    expect(props.onSend).not.toHaveBeenCalled()
  })

  it('takes an exactly typed name over a longer one that starts with it', () => {
    const agents: Command = { name: 'agents', description: 'List the workspace agents' }
    const agent: Command = { name: 'agent', description: 'Hand a task to an agent' }
    const props = baseProps({ commands: [agents, agent] })
    render(<Composer {...props} />)
    // Tab completes the name typed, not /agents listed before it.
    const input = type('/agent')
    fireEvent.keyDown(input, { key: 'Tab' })
    expect(input.value).toBe('/agent ')
    // Enter on the exact name runs it.
    fireEvent.keyDown(type('/agent'), { key: 'Enter' })
    expect(props.onCommand).toHaveBeenCalledWith(agent, '')
  })

  it('runs a command on Enter when its alias is typed in full, instead of completing it', () => {
    const changes: Command = { name: 'changes', description: 'What changed' }
    const reasoning: Command = { name: 'reasoning', description: 'Thinking effort' }
    const props = baseProps({ commands: [changes, reasoning] })
    render(<Composer {...props} />)
    const input = type('/diff')
    expect(screen.getByRole('listbox', { name: 'Commands' })).toBeInTheDocument()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(props.onCommand).toHaveBeenCalledWith(changes, '')
    fireEvent.keyDown(type('/think'), { key: 'Enter' })
    expect(props.onCommand).toHaveBeenCalledWith(reasoning, '')
    expect(input.value).toBe('')
  })

  it('dismisses the command menu on an outside click', () => {
    render(<Composer {...baseProps()} />)
    type('/ne')
    expect(screen.getByText('Start a new chat')).toBeInTheDocument()

    fireEvent.mouseDown(document.body)
    expect(screen.queryByText('Start a new chat')).not.toBeInTheDocument()
  })

  it('says the turn runs at the highest reasoning level while the draft carries the keyword', () => {
    render(<Composer {...baseProps()} />)
    const input = screen.getByRole('textbox', { name: 'Message' })
    expect(screen.queryByText(ULTRATHINK_HINT)).toBeNull()
    fireEvent.change(input, { target: { value: 'why does this deadlock? ultrathink' } })
    expect(screen.getByRole('status')).toHaveTextContent(ULTRATHINK_HINT)
    // Talking about the word is not using it.
    fireEvent.change(input, { target: { value: 'what does "ultrathink" do?' } })
    expect(screen.queryByText(ULTRATHINK_HINT)).toBeNull()
  })

  it('words the hint by what the keyword will do on this model', () => {
    const { rerender } = render(<Composer {...baseProps()} ultrathinkEffect="already" />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'ultrathink' } })
    expect(screen.getByRole('status')).toHaveTextContent(ULTRATHINK_HINT_ALREADY)
    rerender(<Composer {...baseProps()} ultrathinkEffect="none" />)
    expect(screen.getByRole('status')).toHaveTextContent(ULTRATHINK_HINT_NONE)
    rerender(<Composer {...baseProps()} ultrathinkEffect="raises" />)
    expect(screen.getByRole('status')).toHaveTextContent(ULTRATHINK_HINT)
  })

  it('colours the keyword over the field only where it will raise the turn', () => {
    const { container, rerender } = render(<Composer {...baseProps()} />)
    const input = screen.getByRole('textbox', { name: 'Message' })
    expect(container.querySelector('.composer__mirror')).toBeNull()
    fireEvent.change(input, { target: { value: 'fix it, ultrathink please' } })
    const mirror = container.querySelector('.composer__mirror')!
    // The mirror repeats the draft exactly, so each glyph sits on the field's own.
    expect(mirror.textContent).toBe('fix it, ultrathink please\u200b')
    expect(mirror).toHaveAttribute('aria-hidden', 'true')
    const marks = container.querySelectorAll('.composer__keyword')
    expect(marks).toHaveLength(1)
    expect(marks[0]).toHaveTextContent('ultrathink')
    // Nothing to raise: the hint says so, and the word is left plain.
    rerender(<Composer {...baseProps()} ultrathinkEffect="already" />)
    expect(container.querySelector('.composer__mirror')).toBeNull()
    rerender(<Composer {...baseProps()} ultrathinkEffect="none" />)
    expect(container.querySelector('.composer__mirror')).toBeNull()
  })

  it('leaves a mentioned keyword plain', () => {
    const { container } = render(<Composer {...baseProps()} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
      target: { value: 'open ultrathink.ts and "ultrathink"' }
    })
    expect(container.querySelector('.composer__mirror')).toBeNull()
  })

  it('names the message field, whatever the placeholder says', () => {
    render(<Composer {...baseProps()} />)
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeInTheDocument()
  })

  it('exposes the command menu as a listbox tracking the highlighted option', () => {
    render(<Composer {...baseProps()} />)
    const input = type('/')
    const list = screen.getByRole('listbox', { name: 'Commands' })
    const options = within(list).getAllByRole('option')
    expect(options).toHaveLength(2)
    expect(input).toHaveAttribute('aria-controls', list.id)
    expect(input).toHaveAttribute('aria-activedescendant', options[0].id)
    expect(options[0]).toHaveAttribute('aria-selected', 'true')

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input).toHaveAttribute('aria-activedescendant', options[1].id)
    expect(options[1]).toHaveAttribute('aria-selected', 'true')

    fireEvent.mouseDown(document.body)
    expect(input).not.toHaveAttribute('aria-controls')
    expect(input).not.toHaveAttribute('aria-activedescendant')
  })

  it('keeps the highlighted file in view as the arrows move through the @ list', async () => {
    const files = Array.from({ length: 12 }, (_, i) => `src/file${i}.ts`)
    stubApi({ listWorkspaceFiles: vi.fn().mockResolvedValue(files) })
    const scrolled: string[] = []
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.textContent ?? '')
    }
    try {
      render(<Composer {...baseProps({ workspace: '/proj' })} />)
      const input = type('@src')
      await screen.findByRole('listbox', { name: 'Files' })
      fireEvent.keyDown(input, { key: 'ArrowUp' }) // wraps to the last file
      expect(scrolled.at(-1)).toBe('src/file11.ts')
    } finally {
      Element.prototype.scrollIntoView = original
      delete (window as unknown as { api?: ApiStub }).api
    }
  })

  it('shows the disabled reason as the placeholder', () => {
    render(
      <Composer
        {...baseProps({ disabled: true, disabledReason: 'Set an API key for this model to start…' })}
      />
    )
    expect(screen.getByRole('textbox')).toHaveAttribute(
      'placeholder',
      'Set an API key for this model to start…'
    )
  })

  it('names the @, /, and + shortcuts in the idle placeholder', () => {
    render(<Composer {...baseProps()} />)
    expect(screen.getByRole('textbox')).toHaveAttribute(
      'placeholder',
      'Ask Houston anything…  (@ for files, / for commands, + for attachments)'
    )
  })

  it('queues a message via Mod+Enter while a run is in progress', () => {
    const props = baseProps({ running: true })
    render(<Composer {...props} />)

    const input = type('follow-up work')
    // jsdom isn't a Mac, so the modifier is Ctrl here.
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })

    expect(props.onSend).toHaveBeenCalledWith('follow-up work', undefined)
    expect(input.value).toBe('') // composer clears after queuing
  })

  // Queuing a command as text while running sent the model a literal "/plan" and the
  // command never ran. Mode switches already apply live mid-run (dropdown, Shift+Tab).
  it('runs a built-in command while a run is in progress instead of queuing its text', () => {
    const props = baseProps({ running: true })
    render(<Composer {...props} />)

    const input = type('/plan ')
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(props.onCommand).toHaveBeenCalledWith(expect.objectContaining({ name: 'plan' }), '')
    expect(props.onSend).not.toHaveBeenCalled()
    expect(input.value).toBe('')
  })

  it('holds /compact while a run is in progress, keeping the text', () => {
    const compact: Command = { name: 'compact', description: 'Compact the conversation' }
    const props = baseProps({ running: true, commands: [...COMMANDS, compact] })
    render(<Composer {...props} />)

    const input = type('/compact ')
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(props.onCommand).not.toHaveBeenCalled()
    expect(props.onSend).not.toHaveBeenCalled()
    expect(input.value).toBe('/compact ')
    expect(screen.getByText(/can't run while the agent is working/)).toBeInTheDocument()
  })

  it('still queues an unknown /word while running, as a message', () => {
    const props = baseProps({ running: true })
    render(<Composer {...props} />)

    const input = type('/usr/local/bin is not on PATH')
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })

    expect(props.onSend).toHaveBeenCalledWith('/usr/local/bin is not on PATH', undefined)
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

describe('Composer slash menu', () => {
  const grouped: Command[] = [
    { name: 'new', description: 'Start a new chat', group: 'Chat' },
    { name: 'model', description: 'List or switch the active model', group: 'Modes', args: '[name]' },
    { name: 'rewind', description: 'Rewind to an earlier message', group: 'Review and undo' },
    { name: 'deploy', description: 'Ship it', template: 'Deploy $1' }
  ]

  it('lists every command under headings when only a slash is typed', () => {
    render(<Composer {...baseProps({ commands: grouped })} />)
    type('/')
    const menu = screen.getByRole('listbox', { name: 'Commands' })
    expect(within(menu).getAllByRole('option')).toHaveLength(4)
    expect([...menu.querySelectorAll('.mention-menu__heading')].map((h) => h.textContent)).toEqual([
      'Chat',
      'Modes',
      'Review and undo',
      'Custom'
    ])
  })

  it('shows what may follow a command beside its name', () => {
    render(<Composer {...baseProps({ commands: grouped })} />)
    type('/')
    const model = screen.getAllByRole('option').find((o) => o.textContent?.startsWith('/model'))
    expect(model?.querySelector('.mention-item__name')?.textContent).toBe('/model [name]')
  })

  it('finds a command by part of its name or description, without headings', () => {
    render(<Composer {...baseProps({ commands: grouped })} />)
    type('/wind')
    const menu = screen.getByRole('listbox', { name: 'Commands' })
    expect(within(menu).getAllByRole('option').map((o) => o.textContent)).toEqual([
      '/rewindRewind to an earlier message'
    ])
    expect(menu.querySelector('.mention-menu__heading')).toBeNull()
    type('/switch')
    expect(within(screen.getByRole('listbox', { name: 'Commands' })).getByRole('option')).toHaveTextContent('/model')
  })

  it('completes the highlighted match with Tab even when it was not a prefix match', () => {
    render(<Composer {...baseProps({ commands: grouped })} />)
    const input = type('/wind')
    fireEvent.keyDown(input, { key: 'Tab' })
    expect(input.value).toBe('/rewind ')
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

    // Sent as an invoked turn, so the transcript shows "/review", not the prompt.
    expect(props.onSend).not.toHaveBeenCalled()
    expect(props.onInvoke).toHaveBeenCalledWith({
      text: 'Do the review now.',
      invokedAs: { kind: 'command', label: '/review', detail: 'Review', typed: '/review' }
    })
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
    expect(props.onInvoke).not.toHaveBeenCalled() // a custom prompt stays the user's to edit
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

  it('recalls a /command without opening the command menu, so Up keeps walking history', () => {
    render(<Composer {...baseProps()} />)
    sendPrompt('an older prompt')
    sendPrompt('/plan ')
    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input.value).toBe('/plan')
    expect(screen.queryByRole('listbox', { name: 'Commands' })).toBeNull()
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input.value).toBe('an older prompt')
  })

  it('moves between the lines of a recalled multi-line prompt before switching entries', () => {
    render(<Composer {...baseProps()} />)
    sendPrompt('older')
    sendPrompt('line one\nline two')
    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input.value).toBe('line one\nline two')
    // On the last line, Up is the caret's (not prevented), and the entry stays.
    input.setSelectionRange(input.value.length, input.value.length)
    expect(fireEvent.keyDown(input, { key: 'ArrowUp' })).toBe(true)
    expect(input.value).toBe('line one\nline two')
    // On the first line, Up recalls the older entry.
    input.setSelectionRange(2, 2)
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input.value).toBe('older')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input.value).toBe('line one\nline two')
    // Down on the first line is the caret's too.
    input.setSelectionRange(0, 0)
    expect(fireEvent.keyDown(input, { key: 'ArrowDown' })).toBe(true)
    expect(input.value).toBe('line one\nline two')
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

  it('recalls a /command without opening the command menu', () => {
    render(<Composer {...baseProps({ lastUserMessage: '/plan' })} />)
    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.keyDown(input, { key: 'Escape' })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input.value).toBe('/plan')
    expect(screen.queryByRole('listbox', { name: 'Commands' })).toBeNull()
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

describe('Composer rewind (Esc Esc picker, edit and resend)', () => {
  it('opens the rewind picker on double-Esc in an empty field, instead of recalling', () => {
    const onRewindPicker = vi.fn()
    render(<Composer {...baseProps({ lastUserMessage: 'earlier', onRewindPicker })} />)
    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onRewindPicker).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onRewindPicker).toHaveBeenCalledTimes(1)
    expect(input.value).toBe('')
  })

  it('never opens the picker while a turn runs (Esc stops it there)', () => {
    const onRewindPicker = vi.fn()
    render(<Composer {...baseProps({ running: true, onRewindPicker })} />)
    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.keyDown(input, { key: 'Escape' })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onRewindPicker).not.toHaveBeenCalled()
  })

  it('leaves a draft alone on double-Esc', () => {
    const onRewindPicker = vi.fn()
    render(<Composer {...baseProps({ onRewindPicker })} />)
    const input = type('typing')
    fireEvent.keyDown(input, { key: 'Escape' })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onRewindPicker).not.toHaveBeenCalled()
    expect(input.value).toBe('typing')
  })

  it('puts a prefilled message in the field, again for each new seq', () => {
    const { rerender } = render(<Composer {...baseProps({ prefill: { text: 'edit me', seq: 1 } })} />)
    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(input.value).toBe('edit me')
    fireEvent.change(input, { target: { value: 'changed' } })
    rerender(<Composer {...baseProps({ prefill: { text: 'edit me', seq: 1 } })} />)
    expect(input.value).toBe('changed')
    rerender(<Composer {...baseProps({ prefill: { text: 'edit me', seq: 2 } })} />)
    expect(input.value).toBe('edit me')
  })

  it('sets the draft and its chips aside for an edit, and puts them back on Cancel edit', () => {
    const props = baseProps({ conversationId: 'c1' })
    const { rerender } = render(<Composer {...props} />)
    const input = type('my unsent draft')
    fireEvent.paste(input, { clipboardData: { files: [], getData: () => 'z'.repeat(5000) } })
    expect(screen.getByText('Pasted text')).toBeInTheDocument()

    const edit = { text: 'fix the bug', seq: 1, kind: 'edit' as const }
    rerender(<Composer {...props} editing={{ label: 'fix the bug', mode: 'both' }} prefill={edit} />)
    expect(input.value).toBe('fix the bug')
    // The draft's chip isn't sent inside the edited message.
    expect(screen.queryByText('Pasted text')).toBeNull()

    // Cancel edit: App clears `editing`; the prefill it last sent stays as it was.
    rerender(<Composer {...props} prefill={edit} />)
    expect(input.value).toBe('my unsent draft')
    expect(screen.getByText('Pasted text')).toBeInTheDocument()
  })

  it('keeps the saved draft the user\'s own while an edit is open', () => {
    const props = baseProps({ conversationId: 'c1' })
    const { rerender, unmount } = render(<Composer {...props} />)
    type('my unsent draft')
    rerender(
      <Composer
        {...props}
        editing={{ label: 'fix the bug', mode: 'both' }}
        prefill={{ text: 'fix the bug', seq: 1, kind: 'edit' }}
      />
    )
    unmount() // a chat switch mid-edit
    render(<Composer {...props} />)
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('my unsent draft')
  })

  it('puts the draft back once the edited message is sent, and sends the edit alone', () => {
    const props = baseProps({ conversationId: 'c1' })
    const { rerender } = render(<Composer {...props} />)
    const input = type('my unsent draft')
    fireEvent.paste(input, { clipboardData: { files: [], getData: () => 'z'.repeat(5000) } })
    const edit = { text: 'fix the bug', seq: 1, kind: 'edit' as const }
    rerender(<Composer {...props} editing={{ label: 'fix the bug', mode: 'both' }} prefill={edit} />)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(props.onSend).toHaveBeenCalledWith('fix the bug', undefined)
    rerender(<Composer {...props} prefill={edit} />) // the edit is done
    expect(input.value).toBe('my unsent draft')
    expect(screen.getByText('Pasted text')).toBeInTheDocument()
  })

  it('never replaces a typed draft with a starter suggestion', () => {
    const { rerender } = render(<Composer {...baseProps()} />)
    const input = type('my own words')
    rerender(<Composer {...baseProps({ prefill: { text: 'Explain this repo', seq: 1, kind: 'suggestion' } })} />)
    expect(input.value).toBe('my own words')
    expect(screen.getByText('Clear the message box first to use this suggestion.')).toBeInTheDocument()
    fireEvent.change(input, { target: { value: '' } })
    rerender(<Composer {...baseProps({ prefill: { text: 'Explain this repo', seq: 2, kind: 'suggestion' } })} />)
    expect(input.value).toBe('Explain this repo')
  })

  it('puts an edited message\'s images back with its text (vision models only)', () => {
    const img = { mediaType: 'image/png', data: 'AA==' }
    render(<Composer {...baseProps({ prefill: { text: 'see this', images: [img], seq: 1 } })} />)
    expect(screen.getAllByAltText('attachment')).toHaveLength(1)
  })

  it('drops prefilled images for a model that can\'t see them', () => {
    const img = { mediaType: 'image/png', data: 'AA==' }
    render(<Composer {...baseProps({ vision: false, prefill: { text: 'see this', images: [img], seq: 1 } })} />)
    expect(screen.queryByAltText('attachment')).toBeNull()
  })

  it('shows the editing bar with a mode choice and a cancel', () => {
    const onEditModeChange = vi.fn()
    const onCancelEdit = vi.fn()
    render(
      <Composer
        {...baseProps({
          editing: { label: 'fix the bug', mode: 'both' },
          onEditModeChange,
          onCancelEdit
        })}
      />
    )
    const bar = screen.getByRole('group', { name: 'Editing an earlier message' })
    expect(bar.textContent).toContain('fix the bug')
    expect(bar.textContent).not.toContain('\u2014')
    fireEvent.change(within(bar).getByRole('combobox'), { target: { value: 'conversation' } })
    expect(onEditModeChange).toHaveBeenCalledWith('conversation')
    fireEvent.click(within(bar).getByRole('button', { name: 'Cancel edit' }))
    expect(onCancelEdit).toHaveBeenCalled()
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

  it('keeps a folded large paste across a chat switch (unmount + remount)', () => {
    const { unmount } = render(<Composer {...baseProps({ conversationId: 'c1' })} />)
    const input = type('see this')
    const big = Array.from({ length: 60 }, (_, i) => `log line ${i}`).join('\n')
    fireEvent.paste(input, { clipboardData: { files: [], getData: () => big } })
    expect(screen.getByText('Pasted text')).toBeInTheDocument()
    unmount()

    const props = baseProps({ conversationId: 'c1' })
    render(<Composer {...props} />)
    expect(screen.getByText('Pasted text')).toBeInTheDocument()
    const again = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(again.value).toBe('see this')
    fireEvent.keyDown(again, { key: 'Enter' })
    expect(props.onSend).toHaveBeenCalledWith(`see this\n\n${big}`, undefined)
  })

  it('clears persisted chips once the message is sent', () => {
    const first = render(<Composer {...baseProps({ conversationId: 'c1' })} />)
    const input = type('x')
    fireEvent.paste(input, { clipboardData: { files: [], getData: () => 'z'.repeat(5000) } })
    fireEvent.keyDown(input, { key: 'Enter' })
    first.unmount()

    render(<Composer {...baseProps({ conversationId: 'c1' })} />)
    expect(screen.queryByText('Pasted text')).toBeNull()
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

// Stub window.api for the "+" attachment-menu actions, which call into main.
type ApiStub = Partial<Window['api']>
function stubApi(overrides: ApiStub = {}): void {
  ;(window as unknown as { api: ApiStub }).api = {
    pickAttachmentFiles: vi.fn().mockResolvedValue([]),
    readClipboard: vi.fn().mockResolvedValue({ text: '', image: null }),
    pickDirectory: vi.fn().mockResolvedValue(null),
    listWorkspaceFiles: vi.fn().mockResolvedValue([]),
    getWorkingTreeChanges: vi
      .fn()
      .mockResolvedValue({ isRepo: true, branch: 'main', files: [], added: 0, removed: 0 }),
    ...overrides
  }
}

describe('Composer height', () => {
  it('fits an empty field to its placeholder, and a typed one to its text', () => {
    const { rerender } = render(<Composer {...baseProps()} />)
    const input = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement
    // jsdom lays nothing out: report two lines for the (wrapping) placeholder, one for short text.
    Object.defineProperty(input, 'scrollHeight', {
      configurable: true,
      get: () => (input.value === input.placeholder ? 48 : 24)
    })
    rerender(<Composer {...baseProps({ running: true })} />)
    expect(input.style.height).toBe('48px')
    // Measuring leaves the field empty.
    expect(input.value).toBe('')
    fireEvent.change(input, { target: { value: 'hi' } })
    expect(input.style.height).toBe('24px')
  })

  it('re-fits the empty field when a suggested next message arrives', () => {
    const { rerender } = render(<Composer {...baseProps()} />)
    const input = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement
    Object.defineProperty(input, 'scrollHeight', {
      configurable: true,
      get: () => (input.value.includes('(Tab to use)') ? 72 : 24)
    })
    rerender(<Composer {...baseProps({ suggestion: 'now write the migration and its tests' })} />)
    expect(input.style.height).toBe('72px')
  })
})

describe('Composer + attachment menu', () => {
  beforeEach(() => {
    localStorage.clear()
    stubApi()
  })
  afterEach(() => {
    delete (window as unknown as { api?: ApiStub }).api
  })

  const openMenu = (): void => {
    fireEvent.click(screen.getByRole('button', { name: 'Add attachment' }))
  }

  it('toggles the menu and lists the attachment actions', () => {
    render(<Composer {...baseProps()} />)
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument()

    openMenu()
    expect(screen.getByRole('menuitem', { name: /Upload images/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /Attach files/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /Reference a file/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /Paste from clipboard/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /Add a link/ })).toBeInTheDocument()

    openMenu() // toggles closed
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument()
  })

  it('hides the image actions when the model has no vision', () => {
    render(<Composer {...baseProps({ vision: false })} />)
    expect(screen.queryByRole('button', { name: 'Attach image' })).not.toBeInTheDocument()
    openMenu()
    expect(screen.queryByRole('menuitem', { name: /Upload images/ })).not.toBeInTheDocument()
  })

  it('says how many staged images it removed when the model can\'t see images', async () => {
    const props = baseProps()
    const { container, rerender } = render(<Composer {...props} />)
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
    const shot = (name: string) => new File(['x'], name, { type: 'image/png' })
    fireEvent.change(fileInput, { target: { files: [shot('a.png'), shot('b.png')] } })
    await waitFor(() => expect(screen.getAllByAltText('attachment')).toHaveLength(2))
    rerender(<Composer {...props} vision={false} />)
    expect(screen.queryByAltText('attachment')).toBeNull()
    expect(screen.getByText("Removed 2 images: this model can't see images.")).toBeInTheDocument()
  })

  it('disables "Add current changes" without a workspace', () => {
    render(<Composer {...baseProps({ workspace: null })} />)
    openMenu()
    expect(screen.getByRole('menuitem', { name: /Add current changes/ })).toBeDisabled()
  })

  it('"Reference a file" inserts an @ into the field', () => {
    render(<Composer {...baseProps()} />)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /Reference a file/ }))
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('@')
  })

  it('attaches a picked file and embeds its contents in the sent message', async () => {
    stubApi({
      pickAttachmentFiles: vi.fn().mockResolvedValue([
        { path: '/p/foo.ts', name: 'foo.ts', bytes: 11, content: 'const x = 1', truncated: false, binary: false }
      ])
    })
    const props = baseProps()
    render(<Composer {...props} />)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /Attach files/ }))

    await screen.findByText('foo.ts') // chip appears

    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'look at this' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(props.onSend).toHaveBeenCalledTimes(1)
    const [sent, images] = vi.mocked(props.onSend).mock.calls[0]
    expect(sent).toContain('look at this')
    expect(sent).toContain('File: foo.ts')
    expect(sent).toContain('const x = 1')
    expect(images).toBeUndefined()
  })

  it('removes a context chip before sending', async () => {
    stubApi({
      pickAttachmentFiles: vi.fn().mockResolvedValue([
        { path: '/p/foo.ts', name: 'foo.ts', bytes: 1, content: 'x', truncated: false, binary: false }
      ])
    })
    render(<Composer {...baseProps()} />)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /Attach files/ }))
    await screen.findByText('foo.ts')

    fireEvent.click(screen.getByRole('button', { name: 'Remove foo.ts' }))
    expect(screen.queryByText('foo.ts')).not.toBeInTheDocument()
  })

  it('adds a link via the inline form and sends it as context', async () => {
    const props = baseProps()
    render(<Composer {...props} />)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /Add a link/ }))

    const url = screen.getByLabelText('Link URL')
    fireEvent.change(url, { target: { value: 'example.com/docs' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    await screen.findByText('https://example.com/docs') // chip label, scheme added
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })

    expect(props.onSend).toHaveBeenCalledWith('Link: https://example.com/docs', undefined)
  })

  it('pastes clipboard text into the field', async () => {
    stubApi({ readClipboard: vi.fn().mockResolvedValue({ text: 'pasted text', image: null }) })
    render(<Composer {...baseProps()} />)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /Paste from clipboard/ }))

    await waitFor(() =>
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('pasted text')
    )
  })

  it('attaches the working-tree diff and embeds it on send', async () => {
    stubApi({
      getWorkingTreeChanges: vi.fn().mockResolvedValue({
        isRepo: true,
        branch: 'main',
        added: 1,
        removed: 0,
        files: [
          {
            path: 'a.ts',
            status: 'modified',
            hunks: [{ header: '@@ -1 +1,2 @@', lines: [{ type: 'add', text: 'new line' }] }],
            added: 1,
            removed: 0,
            binary: false
          }
        ]
      })
    })
    const props = baseProps({ workspace: '/repo' })
    render(<Composer {...props} />)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /Add current changes/ }))

    await screen.findByText('Uncommitted changes')
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })

    const [sent] = vi.mocked(props.onSend).mock.calls[0]
    expect(sent).toContain('Uncommitted changes on branch main')
    expect(sent).toContain('+new line')
  })

  it('flashes a notice when there are no uncommitted changes', async () => {
    stubApi({
      getWorkingTreeChanges: vi
        .fn()
        .mockResolvedValue({ isRepo: true, branch: 'main', files: [], added: 0, removed: 0 })
    })
    render(<Composer {...baseProps({ workspace: '/repo' })} />)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /Add current changes/ }))
    expect(await screen.findByText('No uncommitted changes to add.')).toBeInTheDocument()
  })

  it('uploads an image through the file input and sends it', async () => {
    const props = baseProps()
    const { container } = render(<Composer {...props} />)
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['x'], 'shot.png', { type: 'image/png' })
    fireEvent.change(fileInput, { target: { files: [file] } })

    await screen.findByAltText('attachment')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    const [sent, images] = vi.mocked(props.onSend).mock.calls[0]
    expect(sent).toBe('')
    expect(images).toEqual([expect.objectContaining({ mediaType: 'image/png' })])
  })

  // Steering: mid-run, a distinct action from the queue. The queue sends after the
  // run; a steer reaches the model before its next step.
  describe('attention (first-run step 3)', () => {
    it('moves the cursor into the box and adds the glow when it turns on', () => {
      const props = baseProps({ disabled: true })
      const { rerender, container } = render(<Composer {...props} />)
      expect(container.querySelector('.composer--attention')).toBeNull()
      rerender(<Composer {...baseProps({ disabled: false, attention: true })} />)
      expect(document.activeElement).toBe(screen.getByRole('textbox'))
      expect(container.querySelector('.composer--attention')).not.toBeNull()
    })
  })

  describe('steer', () => {
    it('always offers Steer while running (enabled, even when empty), and not otherwise', () => {
      const props = baseProps({ running: true, onSteer: vi.fn() })
      const { rerender } = render(<Composer {...props} />)
      // Steer is the default mid-run, so it's always there and never greyed out.
      expect(screen.getByRole('button', { name: 'Steer' })).toBeEnabled()
      // With nothing typed it just focuses the box.
      fireEvent.click(screen.getByRole('button', { name: 'Steer' }))
      expect(props.onSteer).not.toHaveBeenCalled()
      expect(document.activeElement).toBe(screen.getByRole('textbox'))
      // Not running: the steer button never shows.
      rerender(<Composer {...baseProps({ running: false, onSteer: props.onSteer })} />)
      expect(screen.queryByRole('button', { name: 'Steer' })).toBeNull()
    })

    it('puts Steer in the default (last) send spot, after Queue', () => {
      render(<Composer {...baseProps({ running: true, onSteer: vi.fn() })} />)
      const names = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'))
      expect(names.indexOf('Queue')).toBeLessThan(names.indexOf('Steer'))
      expect(names.indexOf('Steer')).toBeLessThan(names.indexOf('Stop'))
    })

    it('explains both keys in the placeholder while running', () => {
      render(<Composer {...baseProps({ running: true, onSteer: vi.fn() })} />)
      expect(screen.getByRole('textbox')).toHaveAttribute(
        'placeholder',
        expect.stringMatching(/^↵ steers now, (⌘|Ctrl)\+↵ queues for after this run\.$/)
      )
    })

    // While the agent waits on its own question, Enter answers it: a steer typed then
    // sat unread until the question was settled, and looked like it had vanished.
    it('says Enter answers the question while the agent is waiting on one', () => {
      const props = baseProps({ running: true, onSteer: vi.fn(), answering: true })
      render(<Composer {...props} />)
      expect(screen.getByRole('textbox')).toHaveAttribute(
        'placeholder',
        expect.stringMatching(/^↵ answers the agent's question, (⌘|Ctrl)\+↵ queues for after this run\.$/)
      )
      expect(screen.queryByRole('button', { name: 'Steer' })).toBeNull()
      const input = type('Postgres, with a read replica')
      fireEvent.click(screen.getByRole('button', { name: 'Answer' }))
      expect(props.onSteer).toHaveBeenCalledWith('Postgres, with a read replica')
      expect(input.value).toBe('')
    })

    it('Enter steers while running', () => {
      const props = baseProps({ running: true, onSteer: vi.fn() })
      render(<Composer {...props} />)
      const input = type('no, use the existing logger')
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(props.onSteer).toHaveBeenCalledWith('no, use the existing logger')
      expect(props.onSend).not.toHaveBeenCalled()
      expect(input.value).toBe('')
    })

    it('Mod+Enter queues while running', () => {
      const props = baseProps({ running: true, onSteer: vi.fn() })
      render(<Composer {...props} />)
      const input = type('also update the README')
      // jsdom isn't a Mac, so the modifier is Ctrl here.
      fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
      expect(props.onSend).toHaveBeenCalledWith('also update the README', undefined)
      expect(props.onSteer).not.toHaveBeenCalled()
    })

    it('Enter still saves a # rule mid-run instead of steering it', () => {
      const props = baseProps({ running: true, onSteer: vi.fn(), onSaveMemory: vi.fn() })
      render(<Composer {...props} />)
      const input = type('# always run the linter')
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(props.onSteer).not.toHaveBeenCalled()
      expect(screen.getByRole('group', { name: 'Remember instruction' })).toBeInTheDocument()
    })

    it('Enter still sends normally when not running', () => {
      const props = baseProps({ running: false, onSteer: vi.fn() })
      render(<Composer {...props} />)
      const input = type('explain this repo')
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(props.onSend).toHaveBeenCalledWith('explain this repo', undefined)
      expect(props.onSteer).not.toHaveBeenCalled()
    })

    it('steers the text and clears the field, without queuing it', () => {
      const props = baseProps({ running: true, onSteer: vi.fn() })
      render(<Composer {...props} />)
      const input = type('actually, use staging')
      fireEvent.click(screen.getByRole('button', { name: 'Steer' }))
      expect(props.onSteer).toHaveBeenCalledWith('actually, use staging')
      expect(props.onSend).not.toHaveBeenCalled() // steer is not a queue
      expect(input.value).toBe('')
    })

    it('runs a command instead of steering with it', () => {
      const props = baseProps({ running: true, onSteer: vi.fn() })
      render(<Composer {...props} />)
      type('/plan')
      fireEvent.click(screen.getByRole('button', { name: 'Steer' }))
      expect(props.onSteer).not.toHaveBeenCalled()
      expect(props.onCommand).toHaveBeenCalledWith(expect.objectContaining({ name: 'plan' }), '')
    })

    it('runs a ! line in the terminal instead of steering with it', () => {
      const onShellEscape = vi.fn()
      const props = baseProps({ running: true, onSteer: vi.fn(), onShellEscape })
      render(<Composer {...props} />)
      const input = type('!npm test')
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(onShellEscape).toHaveBeenCalledWith('npm test')
      expect(props.onSteer).not.toHaveBeenCalled()
      expect(input.value).toBe('')
    })

    const attachImage = async (container: HTMLElement): Promise<void> => {
      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
      fireEvent.change(fileInput, { target: { files: [new File(['x'], 'shot.png', { type: 'image/png' })] } })
      await screen.findByAltText('attachment')
    }

    it('queues a message with images on Enter rather than steer only its words', async () => {
      const props = baseProps({ running: true, onSteer: vi.fn() })
      const { container } = render(<Composer {...props} />)
      await attachImage(container)
      const input = type('match this mockup')
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(props.onSteer).not.toHaveBeenCalled()
      expect(props.onSend).toHaveBeenCalledWith('match this mockup', [
        expect.objectContaining({ mediaType: 'image/png' })
      ])
      expect(screen.getByText("Queued for after this run: a steer can't carry images.")).toBeInTheDocument()
      expect(screen.queryByAltText('attachment')).toBeNull()
    })

    it('answers a question with the words and keeps the images for the next message', async () => {
      const props = baseProps({ running: true, onSteer: vi.fn(), answering: true })
      const { container } = render(<Composer {...props} />)
      await attachImage(container)
      fireEvent.keyDown(type('the blue one'), { key: 'Enter' })
      expect(props.onSteer).toHaveBeenCalledWith('the blue one')
      expect(props.onSend).not.toHaveBeenCalled()
      expect(screen.getByAltText('attachment')).toBeInTheDocument()
      expect(
        screen.getByText('Answered with the text only. The image stays here for your next message.')
      ).toBeInTheDocument()
    })

    it('the Queue button queues while running', () => {
      const props = baseProps({ running: true, onSteer: vi.fn() })
      render(<Composer {...props} />)
      type('a follow-up for later')
      fireEvent.click(screen.getByRole('button', { name: 'Queue' }))
      expect(props.onSend).toHaveBeenCalledWith('a follow-up for later', undefined)
      expect(props.onSteer).not.toHaveBeenCalled()
    })
  })

  // `#`-capture: a standing instruction, confirmed by scope before it's written —
  // the moment you notice "it should always do X" is when you're least likely to
  // open a rules file and write it down.
  describe('# memory capture', () => {
    it('intercepts a #-line on submit and asks for the scope instead of sending', () => {
      const props = baseProps({ onSaveMemory: vi.fn() })
      render(<Composer {...props} />)
      const input = type('# always run the linter')
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(props.onSend).not.toHaveBeenCalled()
      const bar = screen.getByRole('group', { name: 'Remember instruction' })
      expect(within(bar).getByText(/always run the linter/)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'In this project' })).toBeInTheDocument()
    })

    it('saves at the chosen scope and clears the field', () => {
      const props = baseProps({ onSaveMemory: vi.fn() })
      render(<Composer {...props} />)
      const input = type('# prefer YAML')
      fireEvent.keyDown(input, { key: 'Enter' })
      fireEvent.click(screen.getByRole('button', { name: 'Everywhere' }))
      expect(props.onSaveMemory).toHaveBeenCalledWith('global', 'prefer YAML')
      expect(props.onSend).not.toHaveBeenCalled()
      expect(input.value).toBe('')
    })

    it('can send the #-line as an ordinary message instead', () => {
      const props = baseProps({ onSaveMemory: vi.fn() })
      render(<Composer {...props} />)
      const input = type('# this is actually a heading')
      fireEvent.keyDown(input, { key: 'Enter' })
      fireEvent.click(screen.getByRole('button', { name: 'Send as message' }))
      expect(props.onSend).toHaveBeenCalledWith('# this is actually a heading')
      expect(props.onSaveMemory).not.toHaveBeenCalled()
    })

    it('drops the prompt once the text changes, so a stale note is never saved', () => {
      const props = baseProps({ onSaveMemory: vi.fn() })
      render(<Composer {...props} />)
      const input = type('# prefer YAML')
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(screen.getByRole('group', { name: 'Remember instruction' })).toBeInTheDocument()
      fireEvent.change(input, { target: { value: '# prefer TOML' } })
      expect(screen.queryByRole('group', { name: 'Remember instruction' })).toBeNull()
      expect(props.onSaveMemory).not.toHaveBeenCalled()
      expect(input.value).toBe('# prefer TOML')
    })

    it('puts the prompt away on Cancel or Escape, keeping the text', () => {
      const props = baseProps({ onSaveMemory: vi.fn() })
      render(<Composer {...props} />)
      const input = type('# prefer YAML')
      fireEvent.keyDown(input, { key: 'Enter' })
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(screen.queryByRole('group', { name: 'Remember instruction' })).toBeNull()
      expect(input.value).toBe('# prefer YAML')
      fireEvent.keyDown(input, { key: 'Enter' })
      const esc = fireEvent.keyDown(input, { key: 'Escape' })
      expect(esc).toBe(false) // handled here, so the app doesn't also read it
      expect(screen.queryByRole('group', { name: 'Remember instruction' })).toBeNull()
      expect(props.onSaveMemory).not.toHaveBeenCalled()
      expect(input.value).toBe('# prefer YAML')
    })

    it('does not intercept when there is no memory handler (# is just a message)', () => {
      const props = baseProps()
      render(<Composer {...props} />)
      const input = type('# no handler here')
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(props.onSend).toHaveBeenCalledWith('# no handler here', undefined)
      expect(screen.queryByRole('button', { name: 'In this project' })).toBeNull()
    })
  })
})

describe('Composer + attachment menu from the keyboard', () => {
  const open = (): HTMLElement => {
    const plus = screen.getByRole('button', { name: 'Add attachment' })
    plus.focus()
    fireEvent.click(plus)
    return plus
  }
  const focusedText = (): string => (document.activeElement as HTMLElement).textContent ?? ''

  it('moves focus into the menu and between its items', () => {
    render(<Composer {...baseProps({ workspace: '/ws' })} />)
    const plus = open()
    expect(plus).toHaveAttribute('aria-controls', screen.getByRole('menu', { name: 'Add to message' }).id)
    expect(focusedText()).toContain('Upload images')
    const menu = screen.getByRole('menu')
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(focusedText()).toContain('Attach files')
    fireEvent.keyDown(menu, { key: 'End' })
    expect(focusedText()).toContain('Add a link')
    // Wraps from the last item to the first.
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(focusedText()).toContain('Upload images')
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    expect(focusedText()).toContain('Add a link')
  })

  it('skips a disabled item', () => {
    // No workspace: "Add current changes" is disabled.
    render(<Composer {...baseProps()} />)
    open()
    const menu = screen.getByRole('menu')
    fireEvent.keyDown(menu, { key: 'Home' })
    for (let i = 0; i < 4; i++) fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(focusedText()).toContain('Paste from clipboard')
  })

  it('returns focus to + on Escape, and to the message field on Tab', () => {
    render(<Composer {...baseProps()} />)
    const plus = open()
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(plus)

    open()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Tab' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Message' }))
  })
})

describe('Composer + attachment menu notices', () => {
  const openMenu = (): void => {
    fireEvent.click(screen.getByRole('button', { name: 'Add attachment' }))
  }

  it('says why there are no changes to add outside a git repository', async () => {
    stubApi({ getWorkingTreeChanges: vi.fn().mockResolvedValue({ isRepo: false, files: [], added: 0, removed: 0 }) })
    render(<Composer {...baseProps({ workspace: '/plain' })} />)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /Add current changes/ }))
    expect(
      await screen.findByText("This folder isn't a git repository, so there are no changes to add.")
    ).toBeInTheDocument()
  })

  it('says so when the clipboard is empty', async () => {
    stubApi()
    render(<Composer {...baseProps()} />)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /Paste from clipboard/ }))
    expect(await screen.findByText('The clipboard is empty.')).toBeInTheDocument()
  })

  it('names how many binary files went without their contents', async () => {
    stubApi({
      pickAttachmentFiles: vi.fn().mockResolvedValue([
        { name: 'logo.png', content: '', bytes: 10, binary: true },
        { name: 'a.ts', content: 'x', bytes: 1 }
      ])
    })
    render(<Composer {...baseProps()} />)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /Attach files/ }))
    expect(
      await screen.findByText('Attached 2 files; left out the contents of 1 binary file.')
    ).toBeInTheDocument()
  })

  it('says how many files were left out once the message holds all it can', async () => {
    const picked = (n: number, from = 0) =>
      Array.from({ length: n }, (_, i) => ({ name: `f${from + i}.ts`, content: 'x', bytes: 1 }))
    const pickAttachmentFiles = vi.fn().mockResolvedValueOnce(picked(10)).mockResolvedValueOnce(picked(4, 10))
    stubApi({ pickAttachmentFiles })
    render(<Composer {...baseProps()} />)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /Attach files/ }))
    await screen.findByText('f9.ts')
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /Attach files/ }))
    expect(
      await screen.findByText('Left out 2 files: a message holds up to 12 attachments.')
    ).toBeInTheDocument()
    expect(screen.getByText('f11.ts')).toBeInTheDocument()
    expect(screen.queryByText('f12.ts')).toBeNull()
  })

  it('counts only the files it attached in the binary-file note', async () => {
    const text = Array.from({ length: 11 }, (_, i) => ({ name: `f${i}.ts`, content: 'x', bytes: 1 }))
    stubApi({
      pickAttachmentFiles: vi.fn().mockResolvedValue([
        { name: 'logo.png', content: '', bytes: 10, binary: true },
        ...text,
        { name: 'icon.png', content: '', bytes: 10, binary: true }
      ])
    })
    render(<Composer {...baseProps()} />)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /Attach files/ }))
    expect(
      await screen.findByText(
        'Attached 12 files; left out the contents of 1 binary file. Left out 1 file: a message holds up to 12 attachments.'
      )
    ).toBeInTheDocument()
  })
})

describe('Composer suggested next message', () => {
  it('shows the suggestion as ghost text in the empty box, and Tab puts it in', () => {
    render(<Composer {...baseProps({ suggestion: 'now add tests' })} />)
    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(input.placeholder).toContain('now add tests')
    fireEvent.keyDown(input, { key: 'Tab' })
    expect(input.value).toBe('now add tests')
  })

  it('leaves Tab alone with text in the box, while running, or with no suggestion', () => {
    const { unmount } = render(<Composer {...baseProps({ suggestion: 'now add tests' })} />)
    const input = type('my own')
    fireEvent.keyDown(input, { key: 'Tab' })
    expect(input.value).toBe('my own')
    unmount()
    localStorage.clear() // the unmount saved the draft; start the next box empty
    render(<Composer {...baseProps({ suggestion: 'now add tests', running: true })} />)
    const running = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(running.placeholder).not.toContain('now add tests')
    fireEvent.keyDown(running, { key: 'Tab' })
    expect(running.value).toBe('')
  })
})

describe('Composer power features', () => {
  it('folds a very large paste into a chip that is sent as pasted, and can be expanded', () => {
    const props = baseProps()
    render(<Composer {...props} />)
    const input = type('see this')
    const big = Array.from({ length: 60 }, (_, i) => `log line ${i}`).join('\n')
    fireEvent.paste(input, { clipboardData: { files: [], getData: () => big } })
    expect(input.value).toBe('see this')
    expect(screen.getByText('Pasted text')).toBeInTheDocument()
    expect(screen.getByText('60 lines')).toBeInTheDocument()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(props.onSend).toHaveBeenCalledWith(`see this\n\n${big}`, undefined)
  })

  it('puts a folded paste back in the box on Expand', () => {
    render(<Composer {...baseProps()} />)
    const input = type('')
    const big = 'z'.repeat(5000)
    fireEvent.paste(input, { clipboardData: { files: [], getData: () => big } })
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }))
    expect(input.value).toBe(big)
    expect(screen.queryByText('Pasted text')).toBeNull()
  })

  it('lets an ordinary paste through to the box', () => {
    render(<Composer {...baseProps()} />)
    const input = type('')
    const ev = fireEvent.paste(input, { clipboardData: { files: [], getData: () => 'short' } })
    expect(ev).toBe(true) // not prevented
    expect(screen.queryByText('Pasted text')).toBeNull()
  })

  it('attaches a dropped text file the way + Attach files does', async () => {
    const props = baseProps()
    const { container } = render(<Composer {...props} />)
    const file = new File(['const x = 1\n'], 'a.ts', { type: 'text/plain' })
    fireEvent.drop(container.querySelector('.composer__card')!, { dataTransfer: { files: [file] } })
    expect(await screen.findByText('a.ts')).toBeInTheDocument()
    const input = type('look')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(props.onSend).toHaveBeenCalledWith(expect.stringContaining('File: a.ts'), undefined)
    expect(props.onSend).toHaveBeenCalledWith(expect.stringContaining('const x = 1'), undefined)
  })

  it('says a dropped folder can\'t be attached instead of adding a broken chip', async () => {
    const { container } = render(<Composer {...baseProps()} />)
    const folder = new File([''], 'proj')
    const notes = new File(['# notes\n'], 'notes.md', { type: 'text/markdown' })
    const entry = (isDirectory: boolean) => ({ kind: 'file', webkitGetAsEntry: () => ({ isDirectory }) })
    fireEvent.drop(container.querySelector('.composer__card')!, {
      dataTransfer: { files: [folder, notes], items: [entry(true), entry(false)] }
    })
    expect(
      screen.getByText("A folder can't be attached. Drop it outside the message box to open it as the project.")
    ).toBeInTheDocument()
    expect(await screen.findByText('notes.md')).toBeInTheDocument()
    expect(screen.queryByText('proj')).toBeNull()
  })

  it('says how many dropped files went past what one drop reads', async () => {
    const { container } = render(<Composer {...baseProps()} />)
    const files = Array.from({ length: 13 }, (_, i) => new File(['x'], `d${i}.ts`, { type: 'text/plain' }))
    fireEvent.drop(container.querySelector('.composer__card')!, { dataTransfer: { files } })
    expect(await screen.findByText('Left out 3 files: you can drop up to 10 at a time.')).toBeInTheDocument()
    expect(screen.getByText('d9.ts')).toBeInTheDocument()
    expect(screen.queryByText('d10.ts')).toBeNull()
  })

  it('searches sent messages with Ctrl+R and puts the pick in the box', () => {
    localStorage.setItem('houston.promptHistory', JSON.stringify(['fix the login bug', 'add tests', 'fix lint']))
    render(<Composer {...baseProps()} />)
    const input = type('')
    fireEvent.keyDown(input, { key: 'r', ctrlKey: true })
    const search = screen.getByRole('combobox', { name: 'Search sent messages' })
    expect(within(screen.getByRole('listbox', { name: 'Sent messages' })).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'fix lint',
      'add tests',
      'fix the login bug'
    ])
    fireEvent.change(search, { target: { value: 'fix' } })
    fireEvent.keyDown(search, { key: 'r', ctrlKey: true }) // Ctrl+R again: the next older match
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(input.value).toBe('fix the login bug')
    expect(screen.queryByRole('combobox', { name: 'Search sent messages' })).toBeNull()
  })

  it('closes the search on Escape without changing the box', () => {
    render(<Composer {...baseProps()} />)
    const input = type('draft')
    fireEvent.keyDown(input, { key: 'r', ctrlKey: true })
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Search sent messages' }), { key: 'Escape' })
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(input.value).toBe('draft')
  })
})
