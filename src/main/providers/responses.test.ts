import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { ChatMessage, ChatRequest, ProviderStreamEvent } from '@shared/agent'
import { createResponsesProvider, toResponsesInput, toResponsesTools } from './responses'
import { openaiResponsesReasoning } from './reasoning'

// Mock the lazily-imported SDK so we can feed a synthetic Responses event stream
// and assert how the adapter turns it into provider events.
const h = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('openai', () => {
  class FakeOpenAI {
    responses = { create: h.create }
  }
  return { default: FakeOpenAI }
})

/** Build an async-iterable Responses stream from event literals. */
function streamOf(events: unknown[]): AsyncIterable<unknown> {
  return (async function* () {
    for (const e of events) yield e
  })()
}

describe('toResponsesInput', () => {
  it('maps a user message to input_text', () => {
    const msgs: ChatMessage[] = [{ role: 'user', content: 'hello' }]
    expect(toResponsesInput(msgs)).toEqual([{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }])
  })

  it('includes images as input_image parts', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'see this', images: [{ mediaType: 'image/png', data: 'AAA' }] }
    ]
    const out = toResponsesInput(msgs)
    expect(out[0].content).toEqual([
      { type: 'input_text', text: 'see this' },
      { type: 'input_image', image_url: 'data:image/png;base64,AAA', detail: 'auto' }
    ])
  })

  it('maps an assistant turn with text + tool calls to output_text + function_call items', () => {
    const msgs: ChatMessage[] = [
      {
        role: 'assistant',
        content: 'let me check',
        toolCalls: [{ id: 'call_1', name: 'read_file', arguments: { path: 'a.ts' } }]
      }
    ]
    expect(toResponsesInput(msgs)).toEqual([
      { role: 'assistant', content: [{ type: 'output_text', text: 'let me check' }] },
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' }
    ])
  })

  it('maps a tool result to function_call_output', () => {
    const msgs: ChatMessage[] = [{ role: 'tool', content: 'file body', toolCallId: 'call_1', toolName: 'read_file' }]
    expect(toResponsesInput(msgs)).toEqual([
      { type: 'function_call_output', call_id: 'call_1', output: 'file body' }
    ])
  })

  it('follows a tool result that has images with a user input_image turn', () => {
    const msgs: ChatMessage[] = [
      {
        role: 'tool',
        content: 'Loaded http://localhost:3000/',
        toolCallId: 'call_1',
        toolName: 'view_localhost',
        images: [{ mediaType: 'image/png', data: 'SHOT' }]
      }
    ]
    expect(toResponsesInput(msgs)).toEqual([
      { type: 'function_call_output', call_id: 'call_1', output: 'Loaded http://localhost:3000/' },
      {
        role: 'user',
        content: [{ type: 'input_image', image_url: 'data:image/png;base64,SHOT', detail: 'auto' }]
      }
    ])
  })

  it('emits an empty input_text for a contentless user turn (never empty content)', () => {
    expect(toResponsesInput([{ role: 'user', content: '' }])).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: '' }] }
    ])
  })
})

describe('toResponsesTools', () => {
  it('flattens tool schemas (no nested function wrapper)', () => {
    const tools = [{ name: 'glob', description: 'find', parameters: { type: 'object', properties: {} } }]
    expect(toResponsesTools(tools)).toEqual([
      { type: 'function', name: 'glob', description: 'find', parameters: { type: 'object', properties: {} }, strict: false }
    ])
  })

  it('returns undefined when there are no tools', () => {
    expect(toResponsesTools(undefined)).toBeUndefined()
    expect(toResponsesTools([])).toBeUndefined()
  })
})

describe('openaiResponsesReasoning', () => {
  it('requests effort + summary for a reasoning model when on', () => {
    expect(openaiResponsesReasoning('gpt-5.1', 'high')).toEqual({ effort: 'high', summary: 'auto' })
    expect(openaiResponsesReasoning('o3', 'low')).toEqual({ effort: 'low', summary: 'auto' })
  })

  it('returns undefined when off or unsupported', () => {
    expect(openaiResponsesReasoning('gpt-5.1', 'off')).toBeUndefined()
    expect(openaiResponsesReasoning('gpt-4o', 'high')).toBeUndefined()
  })
})

describe('responses usage reporting', () => {
  beforeEach(() => h.create.mockReset())

  async function drainDoneUsage(usage: Record<string, unknown>): Promise<Record<string, number>> {
    h.create.mockResolvedValue(
      streamOf([
        { type: 'response.output_text.delta', delta: 'ok' },
        { type: 'response.completed', response: { usage } }
      ])
    )
    const provider = createResponsesProvider('k')
    let done: { usage?: Record<string, number> } | undefined
    for await (const ev of provider.streamChat({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'hi' }]
    } as ChatRequest) as AsyncGenerator<ProviderStreamEvent>) {
      if (ev.type === 'done') done = ev as { usage?: Record<string, number> }
    }
    return done?.usage ?? {}
  }

  it('surfaces cached reads from input_tokens_details (subset of input_tokens)', async () => {
    const usage = await drainDoneUsage({
      input_tokens: 8_000,
      output_tokens: 30,
      input_tokens_details: { cached_tokens: 7_000 }
    })
    expect(usage).toEqual({ inputTokens: 8_000, outputTokens: 30, cacheReadTokens: 7_000 })
  })

  it('omits the cache field when no split is reported', async () => {
    const usage = await drainDoneUsage({ input_tokens: 1_000, output_tokens: 10 })
    expect(usage).toEqual({ inputTokens: 1_000, outputTokens: 10 })
  })
})
