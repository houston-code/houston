import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { ChatMessage, ChatRequest, ProviderStreamEvent } from '@shared/agent'
import {
  createResponsesProvider,
  isSummaryUnsupportedError,
  responsesErrorStatus,
  toResponsesInput,
  toResponsesTools
} from './responses'
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

describe('responses max_output_tokens', () => {
  beforeEach(() => h.create.mockReset())

  /** Run one turn and return the params the adapter sent to the SDK. */
  async function paramsFor(req: Partial<ChatRequest>): Promise<Record<string, unknown>> {
    h.create.mockResolvedValue(streamOf([{ type: 'response.completed', response: {} }]))
    const provider = createResponsesProvider('k')
    for await (const _ of provider.streamChat({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'hi' }],
      ...req
    } as ChatRequest) as AsyncGenerator<ProviderStreamEvent>) {
      void _
    }
    return h.create.mock.calls[0][0] as Record<string, unknown>
  }

  it('sends the caller-requested reply cap as max_output_tokens', async () => {
    expect(await paramsFor({ maxTokens: 32 })).toMatchObject({ max_output_tokens: 32 })
  })

  it('omits the cap when the caller sets none (server default applies)', async () => {
    expect(await paramsFor({})).not.toHaveProperty('max_output_tokens')
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

describe('reasoning-summary org gate', () => {
  beforeEach(() => h.create.mockReset())

  /** The exact 400 OpenAI returns to an unverified org asking for reasoning summaries. */
  function summaryGateError(): unknown {
    return {
      status: 400,
      error: {
        message: 'Your organization must be verified to generate reasoning summaries.',
        type: 'invalid_request_error',
        param: 'reasoning.summary',
        code: 'unsupported_value'
      }
    }
  }

  const req: ChatRequest = {
    model: 'o3',
    messages: [{ role: 'user', content: 'hi' }],
    reasoningEffort: 'low'
  }

  async function drain(gen: AsyncGenerator<ProviderStreamEvent>): Promise<ProviderStreamEvent[]> {
    const out: ProviderStreamEvent[] = []
    for await (const e of gen) out.push(e)
    return out
  }

  it('identifies the summary gate error and nothing broader', () => {
    expect(isSummaryUnsupportedError(summaryGateError())).toBe(true)
    // A different 400 must NOT be treated as the gate — swallowing those would hide the
    // parameter drift the provider canary exists to catch.
    expect(
      isSummaryUnsupportedError({ status: 400, error: { param: 'model', code: 'unsupported_value' } })
    ).toBe(false)
    expect(
      isSummaryUnsupportedError({ status: 400, error: { param: 'reasoning.summary', code: 'other' } })
    ).toBe(false)
    expect(isSummaryUnsupportedError({ status: 500 })).toBe(false)
    expect(isSummaryUnsupportedError(null)).toBe(false)
  })

  it('retries without the summary so an unverified org still gets a working turn', async () => {
    h.create
      .mockRejectedValueOnce(summaryGateError())
      .mockResolvedValueOnce(streamOf([{ type: 'response.output_text.delta', delta: 'pong' }]))
    const provider = createResponsesProvider('k')
    const events = await drain(provider.streamChat(req))

    expect(h.create).toHaveBeenCalledTimes(2)
    // First attempt asks for the summary; the retry keeps the effort but drops the summary.
    expect(h.create.mock.calls[0][0].reasoning).toEqual({ effort: 'low', summary: 'auto' })
    expect(h.create.mock.calls[1][0].reasoning).toEqual({ effort: 'low' })
    expect(events).toContainEqual({ type: 'text', text: 'pong' })
  })

  it('remembers the gate so later turns skip the rejected round-trip', async () => {
    h.create
      .mockRejectedValueOnce(summaryGateError())
      .mockResolvedValueOnce(streamOf([]))
      .mockResolvedValueOnce(streamOf([]))
    const provider = createResponsesProvider('k')
    await drain(provider.streamChat(req))
    await drain(provider.streamChat(req))

    // 2 for the first turn (reject + retry), 1 for the second — not another reject.
    expect(h.create).toHaveBeenCalledTimes(3)
    expect(h.create.mock.calls[2][0].reasoning).toEqual({ effort: 'low' })
  })

  it('propagates any other error untouched', async () => {
    const boom = { status: 400, error: { param: 'model', code: 'model_not_found' } }
    h.create.mockRejectedValueOnce(boom)
    const provider = createResponsesProvider('k')
    await expect(drain(provider.streamChat(req))).rejects.toBe(boom)
    expect(h.create).toHaveBeenCalledTimes(1)
  })

  it('does not retry when reasoning was never requested', async () => {
    h.create.mockRejectedValueOnce(summaryGateError())
    const provider = createResponsesProvider('k')
    // gpt-4o is not a reasoning model, so no `reasoning` is sent and there is nothing to drop.
    await expect(
      drain(provider.streamChat({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }))
    ).rejects.toBeDefined()
    expect(h.create).toHaveBeenCalledTimes(1)
  })
})

describe('responsesErrorStatus', () => {
  it('maps the always-transient codes onto retryable statuses', () => {
    expect(responsesErrorStatus('rate_limit_exceeded')).toBe(429)
    expect(responsesErrorStatus('server_error')).toBe(500)
  })

  it('leaves a request-level rejection unmapped, so it is not retried', () => {
    expect(responsesErrorStatus('invalid_prompt')).toBeUndefined()
    expect(responsesErrorStatus('context_length_exceeded')).toBeUndefined()
    expect(responsesErrorStatus(undefined)).toBeUndefined()
  })
})

describe('responses in-band failures', () => {
  /** Run one turn over a synthetic stream and return the error event it produced. */
  async function errorFor(events: unknown[]): Promise<{ message: string; status?: number }> {
    h.create.mockResolvedValue(streamOf(events))
    const provider = createResponsesProvider('k')
    for await (const ev of provider.streamChat({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'hi' }]
    } as ChatRequest) as AsyncGenerator<ProviderStreamEvent>) {
      if (ev.type === 'error') return ev
    }
    throw new Error('the adapter produced no error event')
  }

  it('reports the reason a response.failed nests under response.error', async () => {
    // The regression: the adapter read only the top-level `ev.message`, which
    // response.failed does not carry — so every failed response surfaced as the
    // generic fallback string with no status, and was never retried.
    const ev = await errorFor([
      {
        type: 'response.failed',
        response: { error: { code: 'server_error', message: 'The model is overloaded.' } }
      }
    ])
    expect(ev.message).toBe('The model is overloaded.')
    expect(ev.status).toBe(500)
  })

  it('reports a rate limit as a 429 so the retry budget applies', async () => {
    const ev = await errorFor([
      {
        type: 'response.failed',
        response: { error: { code: 'rate_limit_exceeded', message: 'Rate limit reached.' } }
      }
    ])
    expect(ev.status).toBe(429)
  })

  it('reads the inline fields of a top-level error event', async () => {
    const ev = await errorFor([{ type: 'error', code: 'server_error', message: 'stream broke' }])
    expect(ev).toMatchObject({ message: 'stream broke', status: 500 })
  })

  it('leaves a request-level failure statusless rather than guessing', async () => {
    const ev = await errorFor([
      {
        type: 'response.failed',
        response: { error: { code: 'invalid_prompt', message: 'Your prompt was rejected.' } }
      }
    ])
    expect(ev.message).toBe('Your prompt was rejected.')
    expect(ev.status).toBeUndefined()
  })

  it('still yields something usable when the failure carries no detail at all', async () => {
    const ev = await errorFor([{ type: 'response.failed', response: {} }])
    expect(ev.message).toBe('OpenAI Responses API error')
    expect(ev.status).toBeUndefined()
  })
})
