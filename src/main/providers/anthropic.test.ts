import { describe, it, expect, vi, beforeEach } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import type { ChatMessage, ChatRequest } from '@shared/agent'
import {
  markMessagesCacheBreakpoint,
  createAnthropicProvider,
  isStaleThinkingError,
  toAnthropicMessages
} from './anthropic'

/** Fails if any two adjacent messages share a role — the API 400s on that. */
function assertNoConsecutiveSameRole(out: Anthropic.MessageParam[]): void {
  for (let i = 1; i < out.length; i++) {
    expect(out[i].role, `messages ${i - 1} and ${i} are both '${out[i].role}'`).not.toBe(out[i - 1].role)
  }
}

/** Flatten a mapped message's content into an array of blocks for assertions. */
function blocksOf(m: Anthropic.MessageParam): Array<Record<string, unknown>> {
  return (Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }]) as Array<
    Record<string, unknown>
  >
}

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

/** The per-request options (2nd arg) the SDK was called with — headers, signal. */
function lastRequestOptions(): { headers?: Record<string, string> } {
  return (h.stream.mock.calls.at(-1)![1] ?? {}) as { headers?: Record<string, string> }
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

  it('adds the interleaved-thinking beta header on a legacy Claude 4 model', async () => {
    await captureRequest({ model: 'claude-sonnet-4-5-20250929', reasoningEffort: 'high' })
    expect(lastRequestOptions().headers?.['anthropic-beta']).toBe('interleaved-thinking-2025-05-14')
  })

  it('does not send the interleaved beta header where it is unsupported or automatic', async () => {
    // Haiku 4.5 ignores it, Opus 4.8 interleaves via adaptive thinking, off = no thinking.
    for (const req of [
      { model: 'claude-haiku-4-5', reasoningEffort: 'high' as const },
      { model: 'claude-opus-4-8', reasoningEffort: 'high' as const },
      { model: 'claude-sonnet-4-5-20250929', reasoningEffort: 'off' as const }
    ]) {
      await captureRequest(req)
      expect(lastRequestOptions().headers?.['anthropic-beta']).toBeUndefined()
    }
  })

  it('opts preserved-thinking models into drop_block so an edited history does not 400', async () => {
    for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1']) {
      const params = await captureRequest({ model, reasoningEffort: 'high' })
      expect(params.thinking).toEqual({
        type: 'adaptive',
        display: 'summarized',
        block_binding: { prefix_mismatch_behavior: 'drop_block' }
      })
      expect(lastRequestOptions().headers?.['anthropic-beta']).toBe('thinking-binding-controls-2026-08-01')
    }
  })

  it('leaves models without prefix-bound thinking on the plain adaptive shape', async () => {
    for (const model of ['claude-opus-4-8', 'claude-opus-5', 'claude-sonnet-5', 'claude-fable-5']) {
      const params = await captureRequest({ model, reasoningEffort: 'high' })
      expect(params.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
      expect(lastRequestOptions().headers?.['anthropic-beta']).toBeUndefined()
    }
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

describe('toAnthropicMessages role alternation', () => {
  it('folds a plain user message following a tool result onto the same user turn', () => {
    // The exact tail a stall/landing nudge produces: an assistant tool_use, its
    // result, then a user-role nudge. Two consecutive `user` messages are a 400.
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'do the thing' },
      { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'run', arguments: {} }] },
      { role: 'tool', content: 'exit 0', toolCallId: 't1', toolName: 'run' },
      { role: 'user', content: 'You are close to the iteration cap. Wrap up.' }
    ]
    const out = toAnthropicMessages(msgs, false)

    assertNoConsecutiveSameRole(out)

    // The tool_result and the nudge text ride on one user turn (the last message).
    const merged = out[out.length - 1]
    expect(merged.role).toBe('user')
    const blocks = blocksOf(merged)
    expect(blocks.some((b) => b.type === 'tool_result' && b.tool_use_id === 't1')).toBe(true)
    expect(
      blocks.some((b) => b.type === 'text' && b.text === 'You are close to the iteration cap. Wrap up.')
    ).toBe(true)
  })

  it('folds the nudge onto the last of several parallel tool results', () => {
    const msgs: ChatMessage[] = [
      { role: 'assistant', content: '', toolCalls: [
        { id: 't1', name: 'run', arguments: {} },
        { id: 't2', name: 'run', arguments: {} }
      ] },
      { role: 'tool', content: 'r1', toolCallId: 't1', toolName: 'run' },
      { role: 'tool', content: 'r2', toolCallId: 't2', toolName: 'run' },
      { role: 'user', content: 'nudge' }
    ]
    const out = toAnthropicMessages(msgs, false)

    assertNoConsecutiveSameRole(out)
    // assistant, then a single user turn carrying both results + the nudge.
    expect(out).toHaveLength(2)
    const blocks = blocksOf(out[1])
    expect(blocks.filter((b) => b.type === 'tool_result')).toHaveLength(2)
    expect(blocks.some((b) => b.type === 'text' && b.text === 'nudge')).toBe(true)
  })

  it('still emits a separate user turn when no tool result precedes it', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' }
    ]
    const out = toAnthropicMessages(msgs, false)
    expect(out).toHaveLength(3)
    expect(out[2]).toEqual({ role: 'user', content: 'second' })
  })
})

describe('toAnthropicMessages empty assistant turns', () => {
  /** Every assistant message must carry at least one block, and no text block may be blank. */
  function assertSendable(out: ReturnType<typeof toAnthropicMessages>): void {
    for (const m of out) {
      if (m.role !== 'assistant') continue
      const blocks = blocksOf(m)
      expect(blocks.length).toBeGreaterThan(0)
      for (const b of blocks) {
        if (b.type === 'text') expect(String(b.text).trim()).not.toBe('')
      }
    }
  }

  it('leaves out a reply with no text and no tool calls, joining the user turns around it', () => {
    // An empty end_turn reply is persisted as-is; resending it as `content: []` was a
    // 400 on every later request in the conversation.
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: '' },
      { role: 'user', content: 'second' }
    ]
    const out = toAnthropicMessages(msgs, false)
    assertSendable(out)
    assertNoConsecutiveSameRole(out)
    expect(out).toHaveLength(1)
    expect(blocksOf(out[0]).map((b) => b.text)).toEqual(['first', 'second'])
  })

  it('folds the next user turn onto tool results when the reply after them was empty', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'run', arguments: {} }] },
      { role: 'tool', content: 'exit 0', toolCallId: 't1', toolName: 'run' },
      { role: 'assistant', content: '' },
      { role: 'user', content: 'and now?' }
    ]
    const out = toAnthropicMessages(msgs, false)
    assertSendable(out)
    assertNoConsecutiveSameRole(out)
    expect(out).toHaveLength(3)
    const blocks = blocksOf(out[2])
    expect(blocks.some((b) => b.type === 'tool_result' && b.tool_use_id === 't1')).toBe(true)
    expect(blocks.some((b) => b.type === 'text' && b.text === 'and now?')).toBe(true)
  })

  it('drops a whitespace-only text block but keeps the tool calls beside it', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '\n\n', toolCalls: [{ id: 't1', name: 'run', arguments: {} }] },
      { role: 'tool', content: 'ok', toolCallId: 't1', toolName: 'run' }
    ]
    const out = toAnthropicMessages(msgs, false)
    assertSendable(out)
    expect(blocksOf(out[1]).map((b) => b.type)).toEqual(['tool_use'])
  })

  it('leaves out a reasoning-only reply whose blocks are not replayed to this model', () => {
    // A reply cut off mid-thought has reasoning and nothing else; once those blocks are
    // not sent (thinking off, or a different model), nothing is left to send.
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'first' },
      {
        role: 'assistant',
        content: '',
        reasoning: [{ text: 'hmm', signature: 'sig', model: 'claude-opus-5-5' }]
      },
      { role: 'user', content: 'second' }
    ]
    expect(toAnthropicMessages(msgs, false)).toHaveLength(1)
    // Replayed to the model that signed it, the reasoning is the turn's content.
    const replayed = toAnthropicMessages(msgs, true, 'claude-opus-5-5')
    expect(replayed).toHaveLength(3)
    expect(blocksOf(replayed[1]).map((b) => b.type)).toEqual(['thinking'])
  })
})

describe('anthropic usage reporting', () => {
  beforeEach(() => h.stream.mockReset())

  /** A fake stream whose finalMessage reports the given usage counts. */
  function streamWithUsage(usage: Record<string, number>): unknown {
    return {
      async *[Symbol.asyncIterator]() {
        /* no streamed events */
      },
      finalMessage: async () => ({ content: [], stop_reason: 'end_turn', usage })
    }
  }

  async function drainDoneUsage(usage: Record<string, number>): Promise<Record<string, number>> {
    h.stream.mockReturnValue(streamWithUsage(usage))
    const provider = createAnthropicProvider('sk-test')
    const gen = provider.streamChat({
      model: 'claude-opus-4-8',
      messages: [{ role: 'user', content: 'hi' }]
    } as ChatRequest)
    let done: { usage?: Record<string, number> } | undefined
    for await (const ev of gen) {
      if (ev.type === 'done') done = ev as { usage?: Record<string, number> }
    }
    return done?.usage ?? {}
  }

  it('reports total input (fresh + cache read + cache write) and surfaces the split', async () => {
    const usage = await drainDoneUsage({
      input_tokens: 500,
      cache_read_input_tokens: 9000,
      cache_creation_input_tokens: 500,
      output_tokens: 42
    })
    expect(usage.inputTokens).toBe(10_000) // 500 + 9000 + 500 — full context for the meter
    expect(usage.cacheReadTokens).toBe(9000)
    expect(usage.cacheWriteTokens).toBe(500)
    expect(usage.outputTokens).toBe(42)
  })

  it('omits the cache fields when no caching happened', async () => {
    const usage = await drainDoneUsage({ input_tokens: 1000, output_tokens: 10 })
    expect(usage.inputTokens).toBe(1000)
    expect(usage.cacheReadTokens).toBeUndefined()
    expect(usage.cacheWriteTokens).toBeUndefined()
  })
})

/** A stream that fails on its first event, the way the SDK surfaces a rejected request. */
function failingStream(err: unknown): unknown {
  return {
    [Symbol.asyncIterator]() {
      return { next: () => Promise.reject(err) }
    },
    finalMessage: () => Promise.reject(err)
  }
}

/** A prior assistant turn carrying a signed thinking block from `model`, then a new user turn. */
function historyWithThinking(model: string): ChatMessage[] {
  return [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'answer', reasoning: [{ text: 'thought', signature: 'sig', model }] },
    { role: 'user', content: 'second' }
  ]
}

const sentThinkingBlocks = (call: number): number =>
  ((h.stream.mock.calls[call][0] as { messages: Anthropic.MessageParam[] }).messages ?? [])
    .flatMap((m) => blocksOf(m))
    .filter((b) => b.type === 'thinking').length

async function drain(req: Partial<ChatRequest> & { model: string }): Promise<void> {
  const gen = createAnthropicProvider('sk-test').streamChat({
    messages: [{ role: 'user', content: 'hi' }],
    ...req
  } as ChatRequest)
  while (!(await gen.next()).done) {
    /* drain */
  }
}

describe('reasoning off on models that always think', () => {
  beforeEach(() => h.stream.mockReset())

  it('runs at the lowest effort with reasoning hidden, instead of the model default', async () => {
    const params = await captureRequest({ model: 'claude-opus-5-5', reasoningEffort: 'off' })
    expect(params.thinking).toMatchObject({ type: 'adaptive', display: 'omitted' })
    expect(params.output_config).toEqual({ effort: 'low' })
  })

  it('keeps replaying the signed blocks so the reasoning chain stays intact', async () => {
    h.stream.mockReturnValue(fakeStream())
    await drain({ model: 'claude-fable-5-1', reasoningEffort: 'off', messages: historyWithThinking('claude-fable-5-1') })
    expect(sentThinkingBlocks(0)).toBe(1)
  })

  it('still sends nothing for a model that does not think unprompted', async () => {
    const params = await captureRequest({ model: 'claude-opus-4-8', reasoningEffort: 'off' })
    expect(params.thinking).toBeUndefined()
  })
})

describe('stale prefix-bound thinking recovery', () => {
  beforeEach(() => h.stream.mockReset())

  const stale = Object.assign(
    new Error(
      'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.'
    ),
    { status: 400 }
  )

  it('detects the binding 400 and nothing else', () => {
    expect(isStaleThinkingError(stale)).toBe(true)
    expect(isStaleThinkingError(Object.assign(new Error('max_tokens: too large'), { status: 400 }))).toBe(false)
    expect(isStaleThinkingError(Object.assign(new Error(stale.message), { status: 500 }))).toBe(false)
    expect(isStaleThinkingError(null)).toBe(false)
  })

  it('strips the replayed thinking blocks and retries once', async () => {
    h.stream.mockReturnValueOnce(failingStream(stale)).mockReturnValueOnce(fakeStream())
    await drain({ model: 'claude-opus-5-5', reasoningEffort: 'high', messages: historyWithThinking('claude-opus-5-5') })
    expect(h.stream).toHaveBeenCalledTimes(2)
    expect(sentThinkingBlocks(0)).toBe(1)
    expect(sentThinkingBlocks(1)).toBe(0)
    // Thinking itself stays on for the retry; only the stale history blocks go.
    expect((h.stream.mock.calls[1][0] as { thinking?: unknown }).thinking).toMatchObject({ type: 'adaptive' })
  })

  it('does not retry an unrelated 400, or a model whose blocks are not prefix-bound', async () => {
    const other = Object.assign(new Error('tools.0: invalid schema'), { status: 400 })
    h.stream.mockReturnValueOnce(failingStream(other))
    await expect(drain({ model: 'claude-opus-5-5', reasoningEffort: 'high' })).rejects.toBe(other)
    h.stream.mockReset()
    h.stream.mockReturnValueOnce(failingStream(stale))
    await expect(drain({ model: 'claude-opus-4-8', reasoningEffort: 'high' })).rejects.toBe(stale)
    expect(h.stream).toHaveBeenCalledTimes(1)
  })

  it('gives up after one retry rather than looping', async () => {
    h.stream.mockReturnValue(failingStream(stale))
    await expect(
      drain({ model: 'claude-sonnet-5-5', reasoningEffort: 'high', messages: historyWithThinking('claude-sonnet-5-5') })
    ).rejects.toBe(stale)
    expect(h.stream).toHaveBeenCalledTimes(2)
  })
})
