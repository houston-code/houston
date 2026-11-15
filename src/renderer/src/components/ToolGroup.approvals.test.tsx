import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolItem } from '../lib/items'
import { resetKeyActivity } from '../lib/approvalKeys'
import { ApprovalOrderContext, ToolGroup } from './ToolGroup'
import { Transcript } from './Transcript'

// Allowing with a note, the "Approval 2 of 5" count, and the second click a command
// that can throw away work takes.

const waiting = (id: string, over: Partial<ToolItem> = {}): ToolItem =>
  ({
    kind: 'tool',
    id,
    name: 'run_shell',
    status: 'awaiting-approval',
    args: { command: 'npm test' },
    ...over
  }) as ToolItem

const discard = (id: string): ToolItem => waiting(id, { args: { command: 'git reset --hard' }, discardsWork: true })

describe('approval prompt: notes, counts and discards', () => {
  beforeEach(() => resetKeyActivity())
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('sends a note with Allow once or Allow for this chat, never the deny reason', () => {
    const onApprove = vi.fn()
    render(<ToolGroup items={[waiting('c1')]} onApprove={onApprove} />)
    // A reason typed for a denial is not sent with an allow.
    fireEvent.change(screen.getByLabelText('Reason for denying, sent to the agent'), { target: { value: 'no' } })
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    expect(onApprove).toHaveBeenLastCalledWith('c1', 'allow')

    fireEvent.click(screen.getByRole('button', { name: 'Allow with a note…' }))
    const note = screen.getByLabelText('Note sent to the agent with your approval')
    fireEvent.change(note, { target: { value: 'keep the old build' } })
    fireEvent.click(screen.getByRole('button', { name: 'Allow for this chat' }))
    expect(onApprove).toHaveBeenLastCalledWith('c1', 'always', 'keep the old build')
    fireEvent.keyDown(note, { key: 'Enter' })
    expect(onApprove).toHaveBeenLastCalledWith('c1', 'allow', 'keep the old build')
    // Y outside the box carries it too.
    note.blur()
    fireEvent.keyDown(document.body, { key: 'y' })
    expect(onApprove).toHaveBeenLastCalledWith('c1', 'allow', 'keep the old build')
    // Deny still sends only the reason.
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    expect(onApprove).toHaveBeenLastCalledWith('c1', 'deny', 'no')
    // Closing the note box drops it.
    fireEvent.click(screen.getByRole('button', { name: 'No note' }))
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    expect(onApprove).toHaveBeenLastCalledWith('c1', 'allow')
  })

  it('a command that can throw away work offers no chat grant and runs on a second click', () => {
    const onApprove = vi.fn()
    render(<ToolGroup items={[discard('c2')]} onApprove={onApprove} />)
    expect(screen.queryByRole('button', { name: 'Allow for this chat' })).not.toBeInTheDocument()
    expect(screen.getByText(/can throw away work in the project/)).not.toHaveTextContent('—')
    expect(screen.getByText(/Allowing takes a second click/)).not.toHaveTextContent('—')
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    expect(onApprove).not.toHaveBeenCalled()
    expect(screen.getByRole('status')).toHaveTextContent('Click Confirm: run it')
    fireEvent.click(screen.getByRole('button', { name: 'Confirm: run it' }))
    expect(onApprove).toHaveBeenCalledWith('c2', 'allow')
  })

  it('a discard takes Y twice, ignores A, and confirms "Always allow" the same way', () => {
    const onApprove = vi.fn()
    render(<ToolGroup items={[discard('c3')]} onApprove={onApprove} />)
    fireEvent.keyDown(document.body, { key: 'a' })
    fireEvent.keyDown(document.body, { key: 'y' })
    expect(onApprove).not.toHaveBeenCalled()
    fireEvent.keyDown(document.body, { key: 'y' })
    expect(onApprove).toHaveBeenCalledWith('c3', 'allow', undefined)

    const second = vi.fn()
    document.body.innerHTML = ''
    render(<ToolGroup items={[discard('c4')]} onApprove={second} />)
    fireEvent.click(screen.getByRole('button', { name: 'Always allow' }))
    expect(second).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm: always allow' }))
    expect(second).toHaveBeenCalledWith('c4', 'rule-allow')
    // A denial needs no confirmation.
    const third = vi.fn()
    document.body.innerHTML = ''
    render(<ToolGroup items={[discard('c5')]} onApprove={third} />)
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    expect(third).toHaveBeenCalledWith('c5', 'deny', undefined)
  })

  it('says which of several waiting approvals each is, and nothing for a single one', () => {
    render(
      <ApprovalOrderContext.Provider value={['a', 'b', 'c']}>
        <ToolGroup items={[waiting('b')]} onApprove={vi.fn()} />
      </ApprovalOrderContext.Provider>
    )
    expect(screen.getByText('Approval 2 of 3')).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Approval 2 of 3' })).toBeInTheDocument()
    document.body.innerHTML = ''
    render(<ToolGroup items={[waiting('z')]} onApprove={vi.fn()} />)
    expect(screen.queryByText(/Approval \d of \d/)).not.toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Approval' })).toBeInTheDocument()
  })

  it('the transcript numbers its waiting approvals oldest first', () => {
    render(
      <Transcript
        items={[
          waiting('p1'),
          { kind: 'assistant', id: 'm1', text: 'and another', streaming: false },
          waiting('p2', { args: { command: 'npm run build' } }),
          { ...waiting('p0'), status: 'done' } as ToolItem
        ]}
        onApprove={vi.fn()}
        onAnswer={vi.fn()}
        onElicit={vi.fn()}
      />
    )
    expect(screen.getByText('Approval 1 of 2')).toBeInTheDocument()
    expect(screen.getByText('Approval 2 of 2')).toBeInTheDocument()
  })
})
