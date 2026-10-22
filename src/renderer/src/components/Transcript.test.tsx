import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  COMPACTION_SUMMARY_PREFIX,
  type ElicitationResult,
  type ToolApprovalDecision
} from '@shared/agent'

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
  PlanItem,
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
    onElicit: (elicitId: string, result: ElicitationResult) => void
    onOpenPlan: (callId: string) => void
    onRunInTerminal: (command: string) => void
  }> = {}
) {
  const onApprove = handlers.onApprove ?? vi.fn()
  const onAnswer = handlers.onAnswer ?? vi.fn()
  const onElicit = handlers.onElicit ?? vi.fn()
  const onOpenPlan = handlers.onOpenPlan ?? vi.fn()
  const onRunInTerminal = handlers.onRunInTerminal ?? vi.fn()
  const result = render(
    <Transcript
      items={items}
      onApprove={onApprove}
      onAnswer={onAnswer}
      onElicit={onElicit}
      onOpenPlan={onOpenPlan}
      onRunInTerminal={onRunInTerminal}
    />
  )
  return { ...result, onApprove, onAnswer, onElicit, onOpenPlan, onRunInTerminal }
}

function planItem(over: Partial<PlanItem> = {}): PlanItem {
  return {
    kind: 'plan',
    id: 'p1',
    plan: { title: 'Persist the composer draft', steps: ['One'] },
    status: 'pending',
    ...over
  }
}

describe('Transcript', () => {
  it('offers a one-click install for a missing runtime, once', () => {
    const { onRunInTerminal } = renderTranscript([
      {
        kind: 'notice',
        id: 'n1',
        text: "Node.js isn't installed, or isn't on the PATH Houston sees.",
        tone: 'error',
        runtime: { label: 'Node.js', installCommand: 'brew install node', url: 'https://nodejs.org/en/download' }
      }
    ])
    expect(screen.getByText('brew install node')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Download page' })).toHaveAttribute(
      'href',
      'https://nodejs.org/en/download'
    )
    const button = screen.getByRole('button', { name: 'Install Node.js' })
    fireEvent.click(button)
    expect(onRunInTerminal).toHaveBeenCalledWith('brew install node')
    // Disabled after the click so a double-click can't start two installs.
    expect(screen.getByRole('button', { name: /Installing in terminal/ })).toBeDisabled()
    // And the user is told what to do once it finishes.
    expect(screen.getByText(/ask me to continue/)).toBeInTheDocument()
  })

  it('shows only the download page when there is no install command', () => {
    renderTranscript([
      {
        kind: 'notice',
        id: 'n1',
        text: "Python isn't installed, or isn't on the PATH Houston sees.",
        tone: 'error',
        runtime: { label: 'Python', url: 'https://www.python.org/downloads/' }
      }
    ])
    expect(screen.queryByRole('button', { name: /Install/ })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Download page' })).toBeInTheDocument()
  })

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
        onElicit={vi.fn()}
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

  it('shows a copy button on a user turn and copies its exact text', async () => {
    copyText.mockClear()
    copyText.mockResolvedValueOnce(true)
    const { container } = renderTranscript([userItem({ text: 'fix the build' })])

    // The affordance lives on the user bubble, tucked to its left.
    const button = within(container.querySelector('.msg--user')!).getByTitle('Copy message')
    expect(button).toHaveClass('msg__copy--user')
    expect(button.querySelector('[data-icon="copy"]')).toBeInTheDocument()

    fireEvent.click(button)

    // The user's own message text is what gets copied — not the assistant's.
    expect(copyText).toHaveBeenCalledWith('fix the build')
    await waitFor(() => expect(button.querySelector('[data-icon="check"]')).toBeInTheDocument())
  })

  it('omits the copy button on an empty user turn', () => {
    const { container } = renderTranscript([userItem({ text: '   ' })])
    // Nothing meaningful to copy, so the bubble carries no copy affordance.
    expect(container.querySelector('.msg--user .msg__copy')).not.toBeInTheDocument()
  })

  it('omits the copy button on a compaction-summary turn', () => {
    const { container } = renderTranscript([
      userItem({ id: 'u-sum', text: `${COMPACTION_SUMMARY_PREFIX} recap`, isSummary: true })
    ])
    // The summary is system-authored, not the user's input — no copy button.
    expect(container.querySelector('.msg--summary')).toBeInTheDocument()
    expect(container.querySelector('.msg__copy')).not.toBeInTheDocument()
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
        onElicit={vi.fn()}
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
    // A deny also passes the reason box's contents (empty here, so undefined); the
    // allow verdicts pass no note at all. Assert the parts that identify the verdict.
    expect(onApprove.mock.calls[0][0]).toBe('call-42')
    expect(onApprove.mock.calls[0][1]).toBe(decision)
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

  it('renders a pending plan as a marker that re-opens the panel on click', () => {
    const { onOpenPlan } = renderTranscript([planItem()])
    expect(screen.getByText('Plan ready')).toBeInTheDocument()
    expect(screen.getByText('Persist the composer draft')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Plan ready/ }))
    expect(onOpenPlan).toHaveBeenCalledWith('p1')
  })

  it('renders a resolved plan marker as a non-interactive status', () => {
    renderTranscript([planItem({ status: 'accepted' })])
    expect(screen.getByText('Accepted')).toBeInTheDocument()
    // It is no longer "ready" once decided.
    expect(screen.queryByText('Plan ready')).not.toBeInTheDocument()
    expect(screen.getByText('Plan')).toBeInTheDocument()
    // No button — a resolved plan can't be re-opened for a decision.
    expect(screen.queryByRole('button', { name: /Plan ready/ })).not.toBeInTheDocument()
  })
})

describe('Transcript first-party prompt turns', () => {
  const PROMPT = 'Create a GitHub pull request for my current changes, using git and the gh_pr_create tool.'

  it('shows what the user did, with the prompt behind a closed disclosure', () => {
    const { container } = renderTranscript([
      userItem({
        text: PROMPT,
        invokedAs: { kind: 'action', label: 'Create PR', detail: 'Hands off to the agent to commit, push, and open a PR.' }
      })
    ])
    expect(screen.getByText('Create PR')).toBeInTheDocument()
    expect(screen.getByText('Hands off to the agent to commit, push, and open a PR.')).toBeInTheDocument()
    const details = container.querySelector('details.msg__prompt') as HTMLDetailsElement
    expect(details).not.toBeNull()
    expect(details.open).toBe(false)
    // Still in the DOM (so find-in-page and the disclosure reach it), but folded away.
    expect(within(details).getByText(PROMPT)).toBeInTheDocument()
    fireEvent.click(screen.getByText('Instructions sent to the agent'))
    expect(details.open).toBe(true)
  })

  it('copies the prompt the agent received', async () => {
    renderTranscript([userItem({ text: PROMPT, invokedAs: { kind: 'command', label: '/review' } })])
    fireEvent.click(screen.getByTitle('Copy message'))
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(PROMPT))
  })

  it('renders an ordinary turn as a plain bubble', () => {
    const { container } = renderTranscript([userItem({ text: 'fix the login bug' })])
    expect(container.querySelector('.msg__chip')).toBeNull()
    expect(screen.getByText('fix the login bug')).toBeInTheDocument()
  })
})

describe('Transcript: handoff banner link', () => {
  it('links back to the chat that spawned this one', () => {
    const onOpenConversation = vi.fn()
    render(
      <Transcript
        items={[{ kind: 'notice', id: 'h', text: 'Handoff from “Add OAuth”', tone: 'handoff', openConversationId: 'p' }]}
        onApprove={vi.fn()}
        onAnswer={vi.fn()}
        onElicit={vi.fn()}
        onOpenConversation={onOpenConversation}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open that chat' }))
    expect(onOpenConversation).toHaveBeenCalledWith('p')
  })
})

describe('steered messages', () => {
  it('shows a steered message like any other user message, with no label', () => {
    renderTranscript([userItem({ text: 'use the existing logger instead', steered: true })])
    expect(screen.queryByText('Steered')).not.toBeInTheDocument()
    expect(screen.getByText('use the existing logger instead').closest('.msg')?.className).toBe('msg msg--user')
  })
})


describe('Transcript rewind menu', () => {
  const items: DisplayItem[] = [
    userItem({ id: 'sum', text: `${COMPACTION_SUMMARY_PREFIX} earlier`, isSummary: true }),
    userItem({ id: 'u-a', text: 'first ask' }),
    assistantItem({ id: 'a-a' }),
    userItem({ id: 'u-s', text: 'steer it', steered: true }),
    userItem({
      id: 'u-b',
      text: 'expanded review prompt',
      invokedAs: { kind: 'command', label: '/review', typed: '/review src' }
    }),
    assistantItem({ id: 'a-b' })
  ]

  function renderWithRewind(disabled = false) {
    const handlers = { disabled, onRewind: vi.fn(), onEdit: vi.fn() }
    render(
      <Transcript items={items} onApprove={vi.fn()} onAnswer={vi.fn()} onElicit={vi.fn()} rewind={handlers} />
    )
    return handlers
  }

  it('offers rewind on the user’s own messages only, not the summary or a steer', () => {
    renderWithRewind()
    expect(screen.getAllByRole('button', { name: 'Rewind to this message' })).toHaveLength(2)
  })

  it('numbers turns the way main does and passes what the user typed', () => {
    const h = renderWithRewind()
    const [, second] = screen.getAllByRole('button', { name: 'Rewind to this message' })
    fireEvent.click(second)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rewind code only' }))
    expect(h.onRewind).toHaveBeenCalledWith(
      expect.objectContaining({ turn: 1, text: '/review src', label: '/review src' }),
      'code'
    )
  })

  it('each menu choice maps to its mode, and Edit to onEdit', () => {
    const h = renderWithRewind()
    const open = (): void => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Rewind to this message' })[0])
    }
    open()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rewind conversation and code' }))
    open()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rewind conversation only' }))
    expect(h.onRewind.mock.calls.map((c) => [c[0].turn, c[1]])).toEqual([
      [0, 'both'],
      [0, 'conversation']
    ])
    open()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit and resend' }))
    expect(h.onEdit).toHaveBeenCalledWith(expect.objectContaining({ turn: 0, text: 'first ask' }))
  })

  it('is disabled while a turn runs', () => {
    renderWithRewind(true)
    for (const b of screen.getAllByRole('button', { name: 'Rewind to this message' })) {
      expect((b as HTMLButtonElement).disabled).toBe(true)
    }
  })

  it('is hidden without rewind handlers', () => {
    render(<Transcript items={items} onApprove={vi.fn()} onAnswer={vi.fn()} onElicit={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Rewind to this message' })).toBeNull()
  })
})
