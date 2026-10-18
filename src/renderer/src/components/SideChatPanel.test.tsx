import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SideChatPanel } from './SideChatPanel'

interface Api {
  askSideChat: ReturnType<typeof vi.fn>
  cancelSideChat: ReturnType<typeof vi.fn>
  closeSideChat: ReturnType<typeof vi.fn>
  emitProgress: (p: { sideId: string; message: string }) => void
}

function installApi(ask: (...args: unknown[]) => Promise<string>): Api {
  let progress: ((p: { sideId: string; message: string }) => void) | null = null
  const api = {
    askSideChat: vi.fn(ask),
    cancelSideChat: vi.fn(async () => {}),
    closeSideChat: vi.fn(async () => {}),
    onSideChatProgress: (cb: (p: { sideId: string; message: string }) => void) => {
      progress = cb
      return () => {
        progress = null
      }
    }
  }
  window.api = api as unknown as typeof window.api
  return { ...api, emitProgress: (p) => progress?.(p) }
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

afterEach(() => vi.restoreAllMocks())

describe('SideChatPanel', () => {
  it('asks about this chat with the selected model and shows the answer', async () => {
    const api = installApi(async () => 'Because the client is **public**.')
    renderPanel()
    fireEvent.change(input(), { target: { value: 'Why PKCE?' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(await screen.findByText('public')).toBeInTheDocument()
    const [sideId, conv, question, provider, model] = api.askSideChat.mock.calls[0]
    expect(typeof sideId).toBe('string')
    expect([conv, question, provider, model]).toEqual(['conv-1', 'Why PKCE?', 'anthropic', 'claude-sonnet-5'])
    expect(input().value).toBe('')
  })

  it('refuses an empty question with an inline message', () => {
    const api = installApi(async () => 'x')
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
    expect(screen.getByText('Type a question first.')).toBeInTheDocument()
    expect(api.askSideChat).not.toHaveBeenCalled()
    fireEvent.change(input(), { target: { value: 'a' } })
    expect(screen.queryByText('Type a question first.')).toBeNull()
  })

  it('shows progress for its own side chat, and Stop cancels it', async () => {
    let resolve!: (v: string) => void
    const api = installApi(() => new Promise<string>((r) => (resolve = r)))
    renderPanel()
    fireEvent.change(input(), { target: { value: 'q' } })
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
    expect(screen.getByText('Thinking…')).toBeInTheDocument()
    const sideId = api.askSideChat.mock.calls[0][0] as string
    act(() => api.emitProgress({ sideId: 'someone-else', message: 'nope' }))
    act(() => api.emitProgress({ sideId, message: 'Reading auth.ts' }))
    expect(screen.getByText('Reading auth.ts')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(api.cancelSideChat).toHaveBeenCalledWith(sideId)
    await act(async () => resolve('Stopped.'))
    expect(screen.getByRole('button', { name: 'Ask' })).toBeInTheDocument()
  })

  it('shows a failure as an alert without the IPC prefix', async () => {
    installApi(async () => {
      throw new Error("Error invoking remote method 'sideChat:ask': Error: Unknown provider: x")
    })
    renderPanel()
    fireEvent.change(input(), { target: { value: 'q' } })
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/^Unknown provider: x$/)
  })

  it('sends an exchange to the main chat once, or continues it in a new chat', async () => {
    installApi(async () => 'An answer')
    const { props } = renderPanel()
    fireEvent.change(input(), { target: { value: 'A question' } })
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
    const send = await screen.findByRole('button', { name: 'Send to main' })
    fireEvent.click(send)
    expect(props.onSendToMain).toHaveBeenCalledWith('A question', 'An answer')
    expect(screen.getByRole('button', { name: 'Sent to main' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Continue in new chat' }))
    expect(props.onContinueInNewChat).toHaveBeenCalledWith('A question', 'An answer')
  })

  it('forgets its side chat in main when it closes', async () => {
    const api = installApi(async () => 'x')
    const { unmount, props } = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Close side chat' }))
    expect(props.onClose).toHaveBeenCalled()
    unmount()
    await waitFor(() => expect(api.closeSideChat).toHaveBeenCalledTimes(1))
  })
  it('asks for a model before asking without one', () => {
    const api = installApi(async () => 'x')
    renderPanel({ providerId: undefined, model: undefined })
    fireEvent.change(input(), { target: { value: 'q' } })
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
    expect(screen.getByText('Pick a model first.')).toBeInTheDocument()
    expect(api.askSideChat).not.toHaveBeenCalled()
  })
})
