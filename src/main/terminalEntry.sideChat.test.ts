import { describe, expect, it, vi } from 'vitest'

const side = vi.hoisted(() => ({ cancel: vi.fn(), clear: vi.fn(), ask: vi.fn() }))

vi.mock('./sideChat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sideChat')>()),
  cancelSideChat: side.cancel,
  clearSideChat: side.clear,
  askSideChat: side.ask,
  hostSideChatDeps: () => ({})
}))

const { terminalSideChat } = await import('./terminalEntry')

describe('terminalSideChat', () => {
  it('stops the side-chat answer in flight when the terminal cancels it', () => {
    const chat = terminalSideChat()
    expect(chat.cancel).toBeTypeOf('function')
    chat.cancel('conv-1')
    expect(side.cancel).toHaveBeenCalledWith('conv-1')
    expect(side.clear).not.toHaveBeenCalled()
  })

  it('still asks and starts over through the shared side chat', () => {
    const chat = terminalSideChat()
    void chat.ask({ conversationId: 'conv-1' } as Parameters<typeof chat.ask>[0])
    expect(side.ask).toHaveBeenCalledTimes(1)
    chat.clear('conv-1')
    expect(side.clear).toHaveBeenCalledWith('conv-1', expect.objectContaining({ saveSideChat: expect.any(Function) }))
  })
})
