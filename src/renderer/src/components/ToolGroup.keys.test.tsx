import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolItem } from '../lib/items'
import { noteKeyActivity, resetKeyActivity } from '../lib/approvalKeys'
import { ToolGroup } from './ToolGroup'

function tool(over: Partial<ToolItem> & Pick<ToolItem, 'id' | 'name' | 'status'>): ToolItem {
  return { kind: 'tool', ...over } as ToolItem
}

const waiting = (id: string, over: Partial<ToolItem> = {}): ToolItem =>
  tool({ id, name: 'run_shell', status: 'awaiting-approval', args: { command: 'npm test' }, ...over })

describe('approval prompt keys', () => {
  beforeEach(() => resetKeyActivity())
  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('answers Y, A and N with allow, allow for run and deny', () => {
    const onApprove = vi.fn()
    render(<ToolGroup items={[waiting('c1')]} onApprove={onApprove} />)
    fireEvent.keyDown(document.body, { key: 'y' })
    expect(onApprove).toHaveBeenLastCalledWith('c1', 'allow', undefined)
    fireEvent.keyDown(document.body, { key: 'A' })
    expect(onApprove).toHaveBeenLastCalledWith('c1', 'always', undefined)
    fireEvent.keyDown(document.body, { key: 'n' })
    expect(onApprove).toHaveBeenLastCalledWith('c1', 'deny', undefined)
    fireEvent.keyDown(document.body, { key: 'x' })
    expect(onApprove).toHaveBeenCalledTimes(3)
  })

  it('shows each key on its button without changing the button names', () => {
    render(<ToolGroup items={[waiting('c1')]} onApprove={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Allow' })).toHaveAttribute('aria-keyshortcuts', 'Y')
    expect(screen.getByRole('button', { name: 'Allow for run' })).toHaveAttribute('aria-keyshortcuts', 'A')
    expect(screen.getByRole('button', { name: 'Deny' })).toHaveAttribute('aria-keyshortcuts', 'N')
    expect(screen.getByRole('button', { name: 'Always allow' })).not.toHaveAttribute('aria-keyshortcuts')
  })

  it('sends the typed reason with a denial by key', () => {
    const onApprove = vi.fn()
    render(<ToolGroup items={[waiting('c1')]} onApprove={onApprove} />)
    const reason = screen.getByLabelText('Reason for denying, sent to the agent')
    fireEvent.change(reason, { target: { value: 'use staging' } })
    // Typing N in the reason box is typing, not a verdict.
    fireEvent.keyDown(reason, { key: 'n' })
    expect(onApprove).not.toHaveBeenCalled()
    reason.blur()
    fireEvent.keyDown(document.body, { key: 'n' })
    expect(onApprove).toHaveBeenCalledWith('c1', 'deny', 'use staging')
  })

  it('ignores keys while typing in a field, with a modifier, or under a modal dialog', () => {
    const onApprove = vi.fn()
    render(
      <>
        <textarea aria-label="message" />
        <ToolGroup items={[waiting('c1')]} onApprove={onApprove} />
      </>
    )
    const box = screen.getByLabelText('message')
    box.focus()
    fireEvent.keyDown(box, { key: 'y' })
    box.blur()
    fireEvent.keyDown(document.body, { key: 'y', metaKey: true })
    fireEvent.keyDown(document.body, { key: 'y', repeat: true })
    const dialog = document.createElement('div')
    dialog.setAttribute('aria-modal', 'true')
    document.body.appendChild(dialog)
    fireEvent.keyDown(document.body, { key: 'y' })
    expect(onApprove).not.toHaveBeenCalled()
    dialog.remove()
    fireEvent.keyDown(document.body, { key: 'y' })
    expect(onApprove).toHaveBeenCalledTimes(1)
  })

  it('answers only the first waiting prompt when several wait at once', () => {
    const onApprove = vi.fn()
    render(<ToolGroup items={[waiting('c1'), waiting('c2', { args: { command: 'ls' } })]} onApprove={onApprove} />)
    fireEvent.keyDown(document.body, { key: 'y' })
    expect(onApprove).toHaveBeenCalledTimes(1)
    expect(onApprove).toHaveBeenCalledWith('c1', 'allow', undefined)
  })

  it('maps Y to the chat-wide grant and ignores A on the network prompts', () => {
    const onApprove = vi.fn()
    render(<ToolGroup items={[waiting('c1', { egressHost: 'example.com' })]} onApprove={onApprove} />)
    fireEvent.keyDown(document.body, { key: 'a' })
    expect(onApprove).not.toHaveBeenCalled()
    fireEvent.keyDown(document.body, { key: 'y' })
    expect(onApprove).toHaveBeenLastCalledWith('c1', 'always', undefined)
    fireEvent.keyDown(document.body, { key: 'n' })
    expect(onApprove).toHaveBeenLastCalledWith('c1', 'deny', undefined)
  })

  it('takes focus from an empty message box and gives it back once answered', () => {
    const { rerender } = render(
      <>
        <textarea className="composer__input" aria-label="message" />
        <ToolGroup items={[]} onApprove={vi.fn()} />
      </>
    )
    const box = screen.getByLabelText('message')
    box.focus()
    rerender(
      <>
        <textarea className="composer__input" aria-label="message" />
        <ToolGroup items={[waiting('c1')]} onApprove={vi.fn()} />
      </>
    )
    expect(document.activeElement).toBe(screen.getByRole('group', { name: 'Approval' }))
    rerender(
      <>
        <textarea className="composer__input" aria-label="message" />
        <ToolGroup items={[tool({ id: 'c1', name: 'run_shell', status: 'running', args: { command: 'npm test' } })]} onApprove={vi.fn()} />
      </>
    )
    expect(document.activeElement).toBe(box)
  })

  it('leaves focus in a message box that has text, and waits out a burst of typing', () => {
    vi.useFakeTimers()
    const { rerender } = render(
      <>
        <textarea className="composer__input" aria-label="message" defaultValue="" />
        <ToolGroup items={[]} onApprove={vi.fn()} />
      </>
    )
    const box = screen.getByLabelText('message') as HTMLTextAreaElement
    box.focus()
    noteKeyActivity(Date.now())
    rerender(
      <>
        <textarea className="composer__input" aria-label="message" defaultValue="" />
        <ToolGroup items={[waiting('c1')]} onApprove={vi.fn()} />
      </>
    )
    // Just typed: the prompt does not take the box's focus yet.
    expect(document.activeElement).toBe(box)
    // They kept typing text into the box: it stays there.
    box.value = 'also check'
    act(() => void vi.advanceTimersByTime(3000))
    expect(document.activeElement).toBe(box)
    // Cleared and idle: now the prompt takes it.
    box.value = ''
    act(() => void vi.advanceTimersByTime(1000))
    expect(document.activeElement).toBe(screen.getByRole('group', { name: 'Approval' }))
  })
})
