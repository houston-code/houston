import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, Provider, ProviderStreamEvent } from '@shared/agent'
import {
  buildSuggestionMessages,
  maybeSuggestNext,
  MAX_SUGGESTION_LEN,
  sanitizeSuggestion,
  suggestSystemPrompt
} from './suggest'
import { TITLE_MAX_TOKENS } from './title'

const h = vi.hoisted(() => ({
  getProvider: vi.fn(),
  getSettings: vi.fn(),
  collectSecrets: vi.fn(() => [] as string[]),
  createProvider: vi.fn(),
  peekConversation: vi.fn()
}))
vi.mock('../agentHost', () => ({
  getProvider: h.getProvider,
  getSettings: h.getSettings,
  collectSecrets: h.collectSecrets
}))
vi.mock('../providers', () => ({ createProvider: h.createProvider }))
vi.mock('../conversations', () => ({ peekConversation: h.peekConversation }))

const chat: ChatMessage[] = [
  { role: 'user', content: 'add a --shout flag' },
  { role: 'assistant', content: '', toolCalls: [{ id: 't', name: 'edit_file', arguments: {} }] },
  { role: 'tool', content: 'ok', toolCallId: 't', toolName: 'edit_file' },
  { role: 'assistant', content: 'Added --shout to src/index.js.' }
]

describe('buildSuggestionMessages', () => {
  it('sends the last request and the reply that ended the turn, as one message', () => {
    const built = buildSuggestionMessages(chat)!
    expect(built).toHaveLength(1)
    expect(built[0].content).toContain('add a --shout flag')
    expect(built[0].content).toContain('Added --shout')
  })
  it('suggests nothing when the chat does not end on a reply with text', () => {
    expect(buildSuggestionMessages(chat.slice(0, 2))).toBeNull()
    expect(buildSuggestionMessages([])).toBeNull()
  })
  it('keeps a stored credential out of the request', () => {
    h.collectSecrets.mockReturnValueOnce(['sk-live-abcdefghijklmnop'])
    const built = buildSuggestionMessages([
      { role: 'user', content: 'use key sk-live-abcdefghijklmnop' },
      { role: 'assistant', content: 'done' }
    ])!
    expect(built[0].content).not.toContain('sk-live-abcdefghijklmnop')
  })
})

describe('sanitizeSuggestion', () => {
  it('keeps one clean line', () => {
    expect(sanitizeSuggestion('"Now add tests for it"\nextra')).toBe('Now add tests for it')
    expect(sanitizeSuggestion('- Next message: run the tests')).toBe('run the tests')
  })
  it('drops an empty or "nothing" answer, and caps a long one', () => {
    expect(sanitizeSuggestion('  \n ')).toBeNull()
    expect(sanitizeSuggestion('Nothing.')).toBeNull()
    expect(sanitizeSuggestion('x'.repeat(500))!.length).toBe(MAX_SUGGESTION_LEN)
  })
})

describe('maybeSuggestNext', () => {
  const streamOf = (text: string): Provider => ({
    async *streamChat() {
      yield { type: 'text', text } as ProviderStreamEvent
      yield { type: 'done', stopReason: 'end_turn' } as ProviderStreamEvent
    }
  })
  beforeEach(() => {
    vi.clearAllMocks()
    h.peekConversation.mockReturnValue({ id: 'c1', messages: chat })
    h.getProvider.mockReturnValue({ id: 'p', kind: 'openai-compatible', models: [] })
  })

  it('does nothing, and makes no call, unless the user turned it on', async () => {
    h.getSettings.mockReturnValue({})
    const onSuggestion = vi.fn()
    await maybeSuggestNext({ conversationId: 'c1', providerId: 'p', model: 'm', onSuggestion })
    expect(h.createProvider).not.toHaveBeenCalled()
    expect(onSuggestion).not.toHaveBeenCalled()
  })

  it('asks the provider\'s small model, and keeps its "nothing" without a second call', async () => {
    h.getSettings.mockReturnValue({ suggestNextPrompt: true })
    h.getProvider.mockReturnValue({ id: 'p', kind: 'openai', models: [{ id: 'gpt-6.1-sol' }, { id: 'gpt-6-luna' }] })
    const streamChat = vi.fn(streamOf('none').streamChat)
    h.createProvider.mockReturnValue({ streamChat })
    const onSuggestion = vi.fn()
    await maybeSuggestNext({ conversationId: 'c1', providerId: 'p', model: 'gpt-6.1-sol', onSuggestion })
    expect(streamChat).toHaveBeenCalledTimes(1)
    expect((streamChat.mock.calls[0] as unknown as [{ model: string }])[0].model).toBe('gpt-6-luna')
    expect(onSuggestion).not.toHaveBeenCalled()
  })

  it('asks the chat model the way a title is asked, and passes the suggestion on', async () => {
    h.getSettings.mockReturnValue({ suggestNextPrompt: true })
    const streamChat = vi.fn(streamOf('Now add tests').streamChat)
    h.createProvider.mockReturnValue({ streamChat })
    const onSuggestion = vi.fn()
    await maybeSuggestNext({ conversationId: 'c1', providerId: 'p', model: 'm', onSuggestion })
    expect(onSuggestion).toHaveBeenCalledWith('Now add tests')
    const req = streamChat.mock.calls[0][0] as { system: string; maxTokens: number; tools?: unknown }
    expect(req.system).toBe(suggestSystemPrompt)
    expect(req.maxTokens).toBe(TITLE_MAX_TOKENS)
    expect(req.tools).toBeUndefined()
  })

  it('stays silent when the provider fails or cannot be made', async () => {
    h.getSettings.mockReturnValue({ suggestNextPrompt: true })
    const onSuggestion = vi.fn()
    h.createProvider.mockImplementationOnce(() => {
      throw new Error('no key')
    })
    await maybeSuggestNext({ conversationId: 'c1', providerId: 'p', model: 'm', onSuggestion })
    h.createProvider.mockReturnValueOnce({
      async *streamChat() {
        yield { type: 'error', message: 'bad request' } as ProviderStreamEvent
      }
    })
    await maybeSuggestNext({ conversationId: 'c1', providerId: 'p', model: 'm', onSuggestion })
    expect(onSuggestion).not.toHaveBeenCalled()
  })
})
