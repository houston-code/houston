import { describe, it, expect, vi, beforeEach } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import type { ChatRequest } from '@shared/agent'
import { markMessagesCacheBreakpoint, createAnthropicProvider } from './anthropic'

// Mock the lazily-imported SDK so we can capture the exact request body the
// provider builds — the wire shape is what drifted out from under the unit tests.
const h = vi.hoisted(() => ({ stream: vi.fn() }))
vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    messages = { stream: h.stream }
    constructor(_opts: unknown) {}
  }
  return { default: FakeAnthropic }
})

function fakeStream(): unknown {
  return {
    async *[Symbol.asyncIterator]() {
      // no events — we only care about the request, not the response
    },
    finalMessage: async () => ({
      content: [],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 }
    })
  }
}

/** Run a turn against the mocked SDK and return the request body it was sent. */
async function captureRequest(
  req: Partial<ChatRequest> & { model: string }
): Promise<Record<string, unknown>> {
  h.stream.mockReturnValue(fakeStream())
  const provider = createAnthropicProvider('sk-test')
  const gen = provider.streamChat({
    messages: [{ role: 'user', content: 'hi' }],
    ...req
  } as ChatRequest)
  // Drain the generator so the request is actually issued.
  while (!(await gen.next()).done) {
    /* drain */
  }
  return h.stream.mock.calls.at(-1)![0] as Record<string, unknown>
}

describe('anthropic request reasoning params', () => {
  beforeEach(() => h.stream.mockReset())

  it('sends adaptive thinking + output_config.effort for Opus 4.8 (never the legacy shape)', async () => {
    const params = await captureRequest({ model: 'claude-opus-4-8', reasoningEffort: 'high' })
    expect(params.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(params.output_config).toEqual({ effort: 'high' })
    // The removed shape must never reach the SDK — sending it is the 400 we fixed.
    const json = JSON.stringify(params)
    expect(json).not.toContain('budget_tokens')
    expect(json).not.toContain('"enabled"')
  })

  it('passes xhigh through for Opus 4.8', async () => {
    const params = await captureRequest({ model: 'claude-opus-4-8', reasoningEffort: 'xhigh' })
    expect(params.output_config).toEqual({ effort: 'xhigh' })
  })

  it('sends legacy enabled+budget_tokens for Haiku 4.5', async () => {
    const params = await captureRequest({ model: 'claude-haiku-4-5', reasoningEffort: 'high' })
    expect(params.thinking).toMatchObject({ type: 'enabled' })
    expect((params.thinking as { budget_tokens: number }).budget_tokens).toBeGreaterThan(0)
    expect(params.output_config).toBeUndefined()
  })

  it('omits thinking and output_config when reasoning is off', async () => {
    const params = await captureRequest({ model: 'claude-opus-4-8', reasoningEffort: 'off' })
    expect(params.thinking).toBeUndefined()
    expect(params.output_config).toBeUndefined()
  })
})

describe('markMessagesCacheBreakpoint', () => {
  it('converts a trailing string message into a cached text block', () => {
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: 'hello' }]
    markMessagesCacheBreakpoint(messages)
    const content = messages[0].content as Array<{ type: string; cache_control?: unknown }>
    expect(Array.isArray(content)).toBe(true)
    expect(content[0]).toMatchObject({ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } })
  })

  it('marks the last block of an array-content message', () => {
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'a' },
          { type: 'tool_result', tool_use_id: 't2', content: 'b' }
        ]
      }
    ]
    markMessagesCacheBreakpoint(messages)
    const content = messages[0].content as Array<{ cache_control?: unknown }>
    expect(content[0].cache_control).toBeUndefined()
    expect(content[1].cache_control).toEqual({ type: 'ephemeral' })
  })

  it('only marks the most recent message', () => {
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' }
    ]
    markMessagesCacheBreakpoint(messages)
    expect(typeof messages[0].content).toBe('string') // untouched
    expect(Array.isArray(messages[2].content)).toBe(true) // breakpoint here
  })

  it('is a no-op on an empty list', () => {
    expect(() => markMessagesCacheBreakpoint([])).not.toThrow()
  })
})
