import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

  it('dismisses the command menu on an outside click', () => {
    render(<Composer {...baseProps()} />)
    type('/ne')
    expect(screen.getByText('Start a new chat')).toBeInTheDocument()

    fireEvent.mouseDown(document.body)
    expect(screen.queryByText('Start a new chat')).not.toBeInTheDocument()
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
    expect(await screen.findByText('No uncommitted changes')).toBeInTheDocument()
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
