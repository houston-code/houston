import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SideChatView } from '@shared/agent'
import { SideChatPanel } from './SideChatPanel'

/** A fake main process: per-chat stored views, plus a way to announce a change. */
function installApi(views: Record<string, SideChatView> = {}) {
  let listener: ((p: { conversationId: string }) => void) | null = null
  const api = {
    getSideChat: vi.fn(async (id: string) => views[id] ?? { turns: [] }),
    askSideChat: vi.fn(async () => ({ id: 'x', question: 'q', at: 1 })),
    cancelSideChat: vi.fn(async () => {}),
    clearSideChat: vi.fn(async () => {}),
    onSideChatChanged: (cb: (p: { conversationId: string }) => void) => {
      listener = cb
      return () => {
        listener = null
      }
    }
  }
  window.api = api as unknown as typeof window.api
  return {
    api,
    views,
    /** Main says `id`'s side chat changed (with its new stored view). */
    change: (id: string, view: SideChatView) => {
      views[id] = view
      act(() => listener?.({ conversationId: id }))
    }
  }
}

function renderPanel(over: Partial<Parameters<typeof SideChatPanel>[0]> = {}) {
  const props = {
    conversationId: 'conv-1',
    providerId: 'anthropic',
    model: 'claude-sonnet-5',
    onClose: vi.fn(),
    onSendToMain: vi.fn(),
    onContinueInNewChat: vi.fn(),
    onResizeMouseDown: vi.fn(),
    ...over
  }
  return { ...render(<SideChatPanel {...props} />), props }
}

const input = (): HTMLTextAreaElement => screen.getByRole('textbox', { name: 'Side chat question' })
const answered: SideChatView = {
  turns: [{ id: 't1', question: 'Why PKCE?', answer: 'Because the client is **public**.', at: 1 }]
}

afterEach(() => vi.restoreAllMocks())

describe('SideChatPanel', () => {
  it("shows the chat's stored side chat when it opens (it outlives the panel)", async () => {
    installApi({ 'conv-1': answered })
    renderPanel()
    expect(await screen.findByText('public')).toBeInTheDocument()
    expect(screen.getByText('Why PKCE?')).toBeInTheDocument()
  })

  it('asks with the selected model, shows the question at once, and the answer when main announces it', async () => {
    const fake = installApi()
    renderPanel()
    fireEvent.change(input(), { target: { value: 'Why PKCE?' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(fake.api.askSideChat).toHaveBeenCalledWith('conv-1', 'Why PKCE?', 'anthropic', 'claude-sonnet-5')
    expect(screen.getByText('Why PKCE?')).toBeInTheDocument()
    expect(screen.getByText('Thinking…')).toBeInTheDocument()
    expect(input().value).toBe('')
    fake.change('conv-1', { turns: [], pending: { id: 't1', question: 'Why PKCE?', progress: 'Reading auth.ts' } })
    expect(await screen.findByText('Reading auth.ts')).toBeInTheDocument()
    fake.change('conv-1', answered)
    expect(await screen.findByText('public')).toBeInTheDocument()
    expect(screen.queryByText('Thinking…')).toBeNull()
  })

  it("ignores another chat's changes", async () => {
    const fake = installApi()
    renderPanel()
    await waitFor(() => expect(fake.api.getSideChat).toHaveBeenCalledTimes(1))
    fake.change('conv-2', answered)
    expect(fake.api.getSideChat).toHaveBeenCalledTimes(1)
  })

  it('puts a question that was never asked back to edit, with the reason', async () => {
    const fake = installApi()
    fake.api.askSideChat.mockRejectedValueOnce(
      new Error("Error invoking remote method 'sideChat:ask': Error: Wait for the current answer, or stop it first.")
    )
    renderPanel()
    fireEvent.change(input(), { target: { value: 'q' } })
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
    expect(await screen.findByText('Wait for the current answer, or stop it first.')).toBeInTheDocument()
    expect(input().value).toBe('q')
  })

  it('refuses an empty question, or no model, with an inline message', () => {
    const fake = installApi()
    const { unmount } = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
    expect(screen.getByText('Type a question first.')).toBeInTheDocument()
    unmount()
    renderPanel({ providerId: undefined, model: undefined })
    fireEvent.change(input(), { target: { value: 'q' } })
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
    expect(screen.getByText('Pick a model first.')).toBeInTheDocument()
    expect(fake.api.askSideChat).not.toHaveBeenCalled()
  })

  it('shows a stored failure, and Stop cancels the answer in flight', async () => {
    const fake = installApi({
      'conv-1': {
        turns: [{ id: 't1', question: 'q', error: 'rate limited', at: 1 }],
        pending: { id: 't2', question: 'again?' }
      }
    })
    renderPanel()
    expect(await screen.findByRole('alert')).toHaveTextContent('rate limited')
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(fake.api.cancelSideChat).toHaveBeenCalledWith('conv-1')
  })

  it('sends an exchange to the main chat once, or continues it in a new chat', async () => {
    installApi({ 'conv-1': answered })
    const { props } = renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'Send to main' }))
    expect(props.onSendToMain).toHaveBeenCalledWith('Why PKCE?', 'Because the client is **public**.')
    expect(screen.getByRole('button', { name: 'Sent to main' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Continue in new chat' }))
    expect(props.onContinueInNewChat).toHaveBeenCalledWith('Why PKCE?', 'Because the client is **public**.')
  })

  it('"New side chat" clears it in main; closing never does', async () => {
    const fake = installApi({ 'conv-1': answered })
    const { props, unmount } = renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'New side chat' }))
    expect(fake.api.clearSideChat).toHaveBeenCalledWith('conv-1')
    fireEvent.click(screen.getByRole('button', { name: 'Close side chat' }))
    expect(props.onClose).toHaveBeenCalled()
    unmount()
    expect(fake.api.clearSideChat).toHaveBeenCalledTimes(1)
  })

  it('stays mounted while hidden (a plan review has the column), keeping the draft', () => {
    installApi()
    const { rerender, props, container } = renderPanel()
    fireEvent.change(input(), { target: { value: 'half-typed' } })
    rerender(<SideChatPanel {...props} hidden />)
    expect(container.querySelector('aside.side-chat')).toHaveAttribute('hidden')
    rerender(<SideChatPanel {...props} hidden={false} />)
    expect(input().value).toBe('half-typed')
  })
})
