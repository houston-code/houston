import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { ChatMessage, ChatRequest, ProviderStreamEvent } from '@shared/agent'
import { toOpenAIMessages, createOpenAIProvider, modelOptionFromListing } from './openai'

// Mock the lazily-imported SDK so we can feed a synthetic chat-completions stream
// and assert how the adapter turns it into provider events. `ctor` captures the
// client constructor options so we can assert base URL / custom headers wiring.
const h = vi.hoisted(() => ({ create: vi.fn(), ctor: vi.fn() }))
vi.mock('openai', () => {
  class FakeOpenAI {
    chat = { completions: { create: h.create } }
    constructor(opts: unknown) {
      h.ctor(opts)
    }
  }
  return { default: FakeOpenAI }
})

/** Build an async-iterable chat-completions stream from chunk literals. */
function streamOf(chunks: unknown[]): AsyncIterable<unknown> {
  return (async function* () {
    for (const c of chunks) yield c
  })()
}

const textChunk = (content: string): unknown => ({ choices: [{ delta: { content } }] })
const stopChunk = (finish_reason = 'stop'): unknown => ({ choices: [{ delta: {}, finish_reason }] })

const READ_FILE_TOOL = {
  name: 'read_file',
  description: 'Read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } } }
}

async function run(chunks: unknown[], req: Partial<ChatRequest> = {}): Promise<ProviderStreamEvent[]> {
  h.create.mockResolvedValue(streamOf(chunks))
  const provider = createOpenAIProvider('k', 'http://localhost:11434/v1')
  const events: ProviderStreamEvent[] = []
  for await (const e of provider.streamChat({
    model: 'qwen2.5-coder',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [READ_FILE_TOOL],
    ...req
  })) {
    events.push(e)
  }
  return events
}

const textOf = (events: ProviderStreamEvent[]): string =>
  events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')

describe('openai adapter: tool calls emitted as text (Ollama)', () => {
  beforeEach(() => h.create.mockReset())

  it('recovers a tool call that streamed as plain JSON text', async () => {
    // Split the JSON across deltas, as a real stream would deliver it.
    const events = await run([
      textChunk('{"name":"read_file",'),
      textChunk('"arguments":{"path":'),
      textChunk('"TODO.md"}}'),
      stopChunk()
    ])
    const calls = events.filter((e) => e.type === 'tool_call')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      type: 'tool_call',
      call: { name: 'read_file', arguments: { path: 'TODO.md' } }
    })
    // The raw JSON must NOT have been surfaced as text.
    expect(events.some((e) => e.type === 'text')).toBe(false)
    expect(events.find((e) => e.type === 'done')).toMatchObject({ type: 'done', stopReason: 'tool_use' })
  })

  it('streams ordinary prose as text and does not invent a tool call', async () => {
    const events = await run([textChunk('Here are '), textChunk('the gaps.'), stopChunk()])
    expect(textOf(events)).toBe('Here are the gaps.')
    expect(events.some((e) => e.type === 'tool_call')).toBe(false)
    expect(events.find((e) => e.type === 'done')).toMatchObject({ stopReason: 'end_turn' })
  })

  it('keeps content that looks like JSON but names no real tool as text', async () => {
    const events = await run([textChunk('{"summary":"no tool here"}'), stopChunk()])
    expect(events.some((e) => e.type === 'tool_call')).toBe(false)
    expect(textOf(events)).toBe('{"summary":"no tool here"}')
  })

  it('still handles structured tool_calls normally', async () => {
    const events = await run([
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"path":"a"}' } }]
            }
          }
        ]
      },
      stopChunk('tool_calls')
    ])
    const calls = events.filter((e) => e.type === 'tool_call')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ call: { id: 'call_1', name: 'read_file', arguments: { path: 'a' } } })
  })

  it('does not hold content when the request offered no tools', async () => {
    const events = await run([textChunk('{"name":"read_file","arguments":{}}'), stopChunk()], { tools: [] })
    expect(events.some((e) => e.type === 'tool_call')).toBe(false)
    expect(textOf(events)).toBe('{"name":"read_file","arguments":{}}')
  })

  it('strips <tool_response> control tags the model echoes into text', async () => {
    const events = await run([
      textChunk('Here are the results: '),
      textChunk('<tool_response>{"ok":'),
      textChunk('true}</tool_response>'),
      textChunk(' and my analysis.'),
      stopChunk()
    ])
    const text = textOf(events)
    expect(text).not.toContain('tool_response')
    expect(text).not.toContain('{"ok":true}')
    expect(text).toContain('Here are the results:')
    expect(text).toContain('and my analysis.')
  })
})

describe('toOpenAIMessages', () => {
  it('maps a plain user + tool result to text-only messages', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'tool', content: 'file body', toolCallId: 'call_1', toolName: 'read_file' }
    ]
    expect(toOpenAIMessages(undefined, msgs)).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'tool', tool_call_id: 'call_1', content: 'file body' }
    ])
  })

  it('carries user images as image_url content parts', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'see this', images: [{ mediaType: 'image/png', data: 'AAA' }] }
    ]
    expect(toOpenAIMessages(undefined, msgs)).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'see this' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }
        ]
      }
    ])
  })

  it('follows a tool result that has images with a user image_url turn', () => {
    const msgs: ChatMessage[] = [
      {
        role: 'tool',
        content: 'Loaded http://localhost:3000/',
        toolCallId: 'call_1',
        toolName: 'view_localhost',
        images: [{ mediaType: 'image/png', data: 'SHOT' }]
      }
    ]
    expect(toOpenAIMessages(undefined, msgs)).toEqual([
      { role: 'tool', tool_call_id: 'call_1', content: 'Loaded http://localhost:3000/' },
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,SHOT' } }]
      }
    ])
  })
})

describe('openai adapter: client construction (base URL + custom headers)', () => {
  beforeEach(() => {
    h.create.mockReset()
    h.ctor.mockReset()
  })

  /** Drive one streamed turn so the lazily-created client is constructed. */
  async function construct(
    headers?: Record<string, string>,
    baseURL: string | undefined = 'https://openrouter.ai/api/v1'
  ): Promise<Record<string, unknown>> {
    h.create.mockResolvedValue(streamOf([stopChunk()]))
    const provider = createOpenAIProvider('k', baseURL, headers)
    for await (const _e of provider.streamChat({
      model: 'x',
      messages: [{ role: 'user', content: 'hi' }]
    })) {
      void _e
    }
    expect(h.ctor).toHaveBeenCalledTimes(1)
    return h.ctor.mock.calls[0][0] as Record<string, unknown>
  }

  it('passes custom headers as defaultHeaders', async () => {
    const opts = await construct({ 'HTTP-Referer': 'https://app', 'X-Title': 'Houston' })
    expect(opts.defaultHeaders).toEqual({ 'HTTP-Referer': 'https://app', 'X-Title': 'Houston' })
    expect(opts.baseURL).toBe('https://openrouter.ai/api/v1')
  })

  it('omits defaultHeaders when no headers are given', async () => {
    const opts = await construct(undefined)
    expect(opts).not.toHaveProperty('defaultHeaders')
  })

  it('omits defaultHeaders for an empty headers object', async () => {
    const opts = await construct({})
    expect(opts).not.toHaveProperty('defaultHeaders')
  })
})

describe('modelOptionFromListing', () => {
  it('returns just the id for a plain OpenAI-compatible entry', () => {
    expect(modelOptionFromListing({ id: 'qwen2.5-coder', object: 'model' })).toEqual({
      id: 'qwen2.5-coder'
    })
  })

  it('captures OpenRouter-style capability metadata', () => {
    const opt = modelOptionFromListing({
      id: 'deepseek/deepseek-r1',
      context_length: 128000,
      supported_parameters: ['tools', 'reasoning', 'temperature'],
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }
    })
    expect(opt).toEqual({
      id: 'deepseek/deepseek-r1',
      caps: { tools: true, reasoning: true, vision: true, contextWindow: 128000 }
    })
  })

  it('records explicit negative capabilities (text-only, no tools)', () => {
    const opt = modelOptionFromListing({
      id: 'some/base-model',
      supported_parameters: ['temperature', 'top_p'],
      architecture: { input_modalities: ['text'] }
    })
    expect(opt.caps).toEqual({ tools: false, reasoning: false, vision: false })
  })

  it('accepts alternate parameter names (tool_choice / include_reasoning)', () => {
    const opt = modelOptionFromListing({
      id: 'x',
      supported_parameters: ['tool_choice', 'include_reasoning']
    })
    expect(opt.caps).toMatchObject({ tools: true, reasoning: true })
  })

  it('ignores a non-positive or non-numeric context_length', () => {
    expect(modelOptionFromListing({ id: 'a', context_length: 0 })).toEqual({ id: 'a' })
    expect(modelOptionFromListing({ id: 'b', context_length: 'big' })).toEqual({ id: 'b' })
  })
})

describe('openai adapter: reasoning_effort gating', () => {
  beforeEach(() => {
    h.create.mockReset()
    h.ctor.mockReset()
  })

  /** Run one turn and return the body passed to chat.completions.create. */
  async function createBody(req: Partial<ChatRequest>): Promise<Record<string, unknown>> {
    h.create.mockResolvedValue(streamOf([stopChunk()]))
    const provider = createOpenAIProvider('k', 'https://openrouter.ai/api/v1')
    for await (const _e of provider.streamChat({
      model: 'deepseek/deepseek-r1',
      messages: [{ role: 'user', content: 'hi' }],
      ...req
    })) {
      void _e
    }
    return h.create.mock.calls[0][0] as Record<string, unknown>
  }

  it('sends reasoning_effort for a host-listed reasoning model the regex misses', async () => {
    const body = await createBody({ reasoningEffort: 'high', reasoningCapable: true })
    expect(body.reasoning_effort).toBe('high')
  })

  it('omits reasoning_effort when the host says the model cannot reason', async () => {
    const body = await createBody({ reasoningEffort: 'high', reasoningCapable: false })
    expect(body).not.toHaveProperty('reasoning_effort')
  })

  it('falls back to the id heuristic when capability is unknown', async () => {
    const body = await createBody({ reasoningEffort: 'high' })
    expect(body).not.toHaveProperty('reasoning_effort') // deepseek-r1 isn't matched by the regex
  })
})
