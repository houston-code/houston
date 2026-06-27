import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { COMPACTION_SUMMARY_PREFIX, type ToolApprovalDecision } from '@shared/agent'

// The copy button delegates to copyText(); stub it so the copied state is
// deterministic and we can assert on the success path without a real clipboard.
const copyText = vi.fn<(text: string) => Promise<boolean>>(() => Promise.resolve(true))
vi.mock('../lib/clipboard', () => ({
  copyText: (text: string) => copyText(text)
}))
import type {
  AssistantItem,
  DisplayItem,
  NoticeItem,
  QuestionItem,
  ToolItem,
  UserItem
} from '../lib/items'
import { Transcript } from './Transcript'

// ---- DisplayItem fixtures, built from the real lib/items types ----------

function userItem(over: Partial<UserItem> = {}): UserItem {
  return { kind: 'user', id: 'u1', text: 'hello there', ...over }
}

function assistantItem(over: Partial<AssistantItem> = {}): AssistantItem {
  return { kind: 'assistant', id: 'a1', text: 'plain reply', streaming: false, ...over }
}

function toolItem(over: Partial<ToolItem> = {}): ToolItem {
  return { kind: 'tool', id: 'call-1', name: 'read_file', status: 'done', ...over }
}

function noticeItem(over: Partial<NoticeItem> = {}): NoticeItem {
  return { kind: 'notice', id: 'n1', text: 'a notice', tone: 'info', ...over }
}

function questionItem(over: Partial<QuestionItem> = {}): QuestionItem {
  return {
    kind: 'question',
    id: 'q1',
    question: 'Which option?',
    options: [{ label: 'First' }, { label: 'Second' }],
    ...over
  }
}

function renderTranscript(
  items: DisplayItem[],
  handlers: Partial<{
    onApprove: (callId: string, decision: ToolApprovalDecision) => void
    onAnswer: (callId: string, answer: string) => void
  }> = {}
) {
  const onApprove = handlers.onApprove ?? vi.fn()
  const onAnswer = handlers.onAnswer ?? vi.fn()
  const result = render(<Transcript items={items} onApprove={onApprove} onAnswer={onAnswer} />)
  return { ...result, onApprove, onAnswer }
}

describe('Transcript', () => {
  it('renders a user turn as plain text', () => {
    const { container } = renderTranscript([userItem({ text: 'do the thing' })])
    expect(screen.getByText('do the thing')).toBeInTheDocument()
    // Right-aligned user bubble, not the markdown summary block.
    expect(container.querySelector('.msg--user')).toBeInTheDocument()
    expect(container.querySelector('.msg--summary')).not.toBeInTheDocument()
  })

  it('renders a compaction-summary user turn through markdown with a label', () => {
    const { container } = renderTranscript([
      userItem({
        id: 'u-sum',
        text: `${COMPACTION_SUMMARY_PREFIX} **earlier** work was done`,
        isSummary: true
      })
    ])
    expect(container.querySelector('.msg--summary')).toBeInTheDocument()
    expect(screen.getByText(/Summary of earlier conversation/)).toBeInTheDocument()
    // The body after the prefix is parsed as markdown, so the bold is a <strong>.
    expect(container.querySelector('.msg--summary strong')).toHaveTextContent('earlier')
  })

  it('renders an assistant turn as markdown with its actual text', () => {
    const { container } = renderTranscript([
      assistantItem({
        text: '# Migration plan\n\nDeleted the **legacy adapter** before shipping.'
      })
    ])
    const assistant = container.querySelector('.msg--assistant')!
    // The heading text itself must render, not just any <h1>.
    expect(assistant.querySelector('h1')).toHaveTextContent('Migration plan')
    // The bold word renders inside a <strong> with its real content…
    expect(assistant.querySelector('strong')).toHaveTextContent('legacy adapter')
    // …and the surrounding prose is present too, so the whole body made it through.
    expect(assistant).toHaveTextContent('Deleted the legacy adapter before shipping.')
  })

  it('shows a copy button for a finished assistant turn but not while streaming', () => {
    const { container, rerender } = renderTranscript([
      assistantItem({ text: 'final answer', streaming: false })
    ])
    expect(screen.getByTitle('Copy message')).toBeInTheDocument()
    expect(container.querySelector('.md-cursor')).not.toBeInTheDocument()

    rerender(
      <Transcript
        items={[assistantItem({ text: 'partial', streaming: true })]}
        onApprove={vi.fn()}
        onAnswer={vi.fn()}
      />
    )
    expect(screen.queryByTitle('Copy message')).not.toBeInTheDocument()
    // The streaming cursor marks output still in flight.
    expect(container.querySelector('.md-cursor')).toBeInTheDocument()
  })

  it('copies the assistant text and shows a copied affordance when the copy button is clicked', async () => {
    copyText.mockClear()
    copyText.mockResolvedValueOnce(true)
    renderTranscript([assistantItem({ text: 'final answer', streaming: false })])

    const button = screen.getByTitle('Copy message')
    // Idle state shows the copy icon, not the success check.
    expect(button.querySelector('[data-icon="copy"]')).toBeInTheDocument()
    expect(button.querySelector('[data-icon="check"]')).not.toBeInTheDocument()

    fireEvent.click(button)

    // The exact message text is what gets copied.
    expect(copyText).toHaveBeenCalledWith('final answer')
    // After the copy resolves the button flips to the "copied" check affordance.
    await waitFor(() => expect(button.querySelector('[data-icon="check"]')).toBeInTheDocument())
  })

  it('leaves the copy button in its idle state when copying fails', async () => {
    copyText.mockClear()
    copyText.mockResolvedValueOnce(false)
    renderTranscript([assistantItem({ text: 'final answer', streaming: false })])

    const button = screen.getByTitle('Copy message')
    fireEvent.click(button)

    expect(copyText).toHaveBeenCalledWith('final answer')
    // A failed copy must not claim success — the affordance stays the idle icon.
    await Promise.resolve()
    expect(button.querySelector('[data-icon="copy"]')).toBeInTheDocument()
    expect(button.querySelector('[data-icon="check"]')).not.toBeInTheDocument()
  })

  it('renders a tool row with its verb and target', () => {
    const { container } = renderTranscript([
      toolItem({ name: 'read_file', args: { path: '/repo/src/app/main.ts' }, status: 'done' })
    ])
    const row = container.querySelector('.tool-row')!
    expect(within(row as HTMLElement).getByText('Read')).toBeInTheDocument()
    // shortenPath collapses to the last two segments.
    expect(within(row as HTMLElement).getByText('…/app/main.ts')).toBeInTheDocument()
  })

  it('drops navigation-only list_dir tool calls from the transcript', () => {
    const { container } = renderTranscript([
      toolItem({ id: 'c-ld', name: 'list_dir', args: { path: '/repo/src' }, status: 'done' })
    ])
    // groupItems hides list_dir entirely — no tool group should render.
    expect(container.querySelector('.tool-group')).not.toBeInTheDocument()
    expect(container.querySelector('.tool-row')).not.toBeInTheDocument()
  })

  it('renders a notice with its tone class', () => {
    const { container, rerender } = renderTranscript([
      noticeItem({ id: 'n-info', text: 'Stopped.', tone: 'info' })
    ])
    expect(screen.getByText('Stopped.')).toBeInTheDocument()
    expect(container.querySelector('.notice--info')).toBeInTheDocument()

    rerender(
      <Transcript
        items={[noticeItem({ id: 'n-err', text: 'boom failed', tone: 'error' })]}
        onApprove={vi.fn()}
        onAnswer={vi.fn()}
      />
    )
    expect(container.querySelector('.notice--error')).toHaveTextContent('boom failed')
    expect(container.querySelector('.notice--info')).not.toBeInTheDocument()
  })

  // Each approval decision is checked against a fresh render + fresh mock so the
  // single assertion is unambiguous: the click reports exactly that decision and
  // nothing else. (A shared mock would let any earlier click satisfy a later
  // toHaveBeenCalledWith, hiding a button wired to the wrong decision.)
  it.each<[string, ToolApprovalDecision]>([
    ['Allow', 'allow'],
    ['Allow for run', 'always'],
    ['Deny', 'deny']
  ])('reports (callId, %s) decision when its approval button is clicked', (label, decision) => {
    const onApprove = vi.fn()
    renderTranscript(
      [
        toolItem({
          id: 'call-42',
          name: 'run_shell',
          args: { command: 'rm -rf build' },
          status: 'awaiting-approval'
        })
      ],
      { onApprove }
    )

    fireEvent.click(screen.getByRole('button', { name: label }))
    expect(onApprove).toHaveBeenCalledTimes(1)
    expect(onApprove).toHaveBeenCalledWith('call-42', decision)
  })

  it('does not show approval controls for a finished tool', () => {
    renderTranscript([toolItem({ status: 'done', name: 'run_shell', args: { command: 'ls' } })])
    expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Deny' })).not.toBeInTheDocument()
  })

  it('renders an open question card and answers it via an option click', () => {
    const onAnswer = vi.fn()
    renderTranscript(
      [questionItem({ id: 'q-7', question: 'Pick one', options: [{ label: 'Alpha' }, { label: 'Beta' }] })],
      { onAnswer }
    )
    expect(screen.getByText('The agent is asking')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Beta' }))
    expect(onAnswer).toHaveBeenCalledWith('q-7', 'Beta')
  })

  it('answers a question via the free-text fallback', () => {
    const onAnswer = vi.fn()
    renderTranscript([questionItem({ id: 'q-9', options: [] })], { onAnswer })

    const input = screen.getByLabelText('Type a custom answer')
    fireEvent.change(input, { target: { value: 'my own answer' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(onAnswer).toHaveBeenCalledWith('q-9', 'my own answer')
  })

  it('collapses an answered question to a read-only record', () => {
    const onAnswer = vi.fn()
    const { container } = renderTranscript(
      [questionItem({ id: 'q-x', answer: 'Second' })],
      { onAnswer }
    )
    expect(container.querySelector('.question--answered')).toBeInTheDocument()
    expect(screen.getByText('Answered')).toBeInTheDocument()
    // Options are no longer interactive once answered.
    expect(screen.queryByText('The agent is asking')).not.toBeInTheDocument()
  })

  it('folds consecutive tool calls into a single group and renders mixed kinds in order', () => {
    const { container } = renderTranscript([
      userItem({ id: 'u-a', text: 'request' }),
      assistantItem({ id: 'a-a', text: 'working on it' }),
      toolItem({ id: 'c-1', name: 'search_files', args: { pattern: 'needle' }, status: 'done' }),
      toolItem({ id: 'c-2', name: 'run_shell', args: { command: 'npm test' }, status: 'done' }),
      noticeItem({ id: 'n-a', text: 'Stopped.', tone: 'info' })
    ])
    // The two adjacent tools collapse into one group containing two rows.
    const groups = container.querySelectorAll('.tool-group')
    expect(groups).toHaveLength(1)
    const rows = groups[0].querySelectorAll<HTMLElement>('.tool-row')
    expect(rows).toHaveLength(2)

    // First row is the search, with its verb and pattern target.
    expect(within(rows[0]).getByText('Search')).toBeInTheDocument()
    expect(within(rows[0]).getByText('needle')).toBeInTheDocument()
    // Second row is the shell command, with its verb and the command text.
    expect(within(rows[1]).getByText('Run')).toBeInTheDocument()
    expect(within(rows[1]).getByText('npm test')).toBeInTheDocument()

    // The non-tool kinds bracket the group and render in source order.
    expect(screen.getByText('request')).toBeInTheDocument()
    expect(screen.getByText('Stopped.')).toBeInTheDocument()
    const inner = container.querySelector('.transcript__inner')!
    const order = Array.from(inner.children).map((c) => c.className.split(' ')[0])
    expect(order).toEqual(['msg', 'msg', 'tool-group', 'notice'])
  })

  it('renders an empty transcript with no message nodes', () => {
    const { container } = renderTranscript([])
    const inner = container.querySelector('.transcript__inner')!
    expect(inner).toBeInTheDocument()
    expect(inner.childElementCount).toBe(0)
    // Nothing to scroll back to, so no jump-to-bottom affordance.
    expect(screen.queryByTitle('Scroll to bottom')).not.toBeInTheDocument()
  })
})
