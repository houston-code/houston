import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { ChatMessage, ChatRequest, ProviderStreamEvent } from '@shared/agent'
import {
  createGeminiProvider,
  listGeminiModels,
  modelOptionFromGeminiListing,
  toGeminiContents
} from './gemini'

// Mock the lazily-imported SDK so we can feed a synthetic content stream and
// assert how the adapter turns it into provider events.
const h = vi.hoisted(() => ({ stream: vi.fn() }))
vi.mock('@google/genai', () => {
  class GoogleGenAI {
    models = {
      generateContentStream: h.stream,
      list: async () =>
        (async function* () {
          yield { name: 'models/gemini-2.5-pro', inputTokenLimit: 1048576 }
          yield { name: 'models/embedding-001' }
          yield { name: '' }
        })()
    }
  }
  return { GoogleGenAI }
})

describe('toGeminiContents', () => {
  it('maps a user turn and a tool result (functionResponse)', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'tool', content: 'file body', toolCallId: 'call_1', toolName: 'read_file' }
    ]
    expect(toGeminiContents(msgs)).toEqual([
      { role: 'user', parts: [{ text: 'hi' }] },
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'read_file', response: { result: 'file body' } } }]
      }
    ])
  })

  it('follows a tool result that has images with a separate inlineData user turn', () => {
    const msgs: ChatMessage[] = [
      {
        role: 'tool',
        content: 'Loaded http://localhost:3000/',
        toolCallId: 'call_1',
        toolName: 'view_localhost',
        images: [{ mediaType: 'image/png', data: 'SHOT' }]
      }
    ]
    expect(toGeminiContents(msgs)).toEqual([
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'view_localhost', response: { result: 'Loaded http://localhost:3000/' } } }
        ]
      },
      { role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'SHOT' } }] }
    ])
  })

  it('gives a user-message image that follows a tool result its own inlineData turn', () => {
    // A functionResponse part can't share a turn with inlineData, so the image must not
    // fold onto the tool-result turn (only its text does) — it gets a separate turn.
    const msgs: ChatMessage[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'run', arguments: {} }] },
      { role: 'tool', content: 'exit 0', toolCallId: 'c1', toolName: 'run' },
      { role: 'user', content: 'look at this', images: [{ mediaType: 'image/png', data: 'IMG' }] }
    ]
    expect(toGeminiContents(msgs)).toEqual([
      { role: 'model', parts: [{ functionCall: { name: 'run', args: {} } }] },
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'run', response: { result: 'exit 0' } } },
          { text: 'look at this' }
        ]
      },
      { role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'IMG' } }] }
    ])
  })

  it('folds a plain user message following a tool result onto the same user turn', () => {
    // Gemini enforces user/model alternation, so the nudge that a stall/landing
    // check pushes after a tool-using turn must not become a second `user` turn.
    const msgs: ChatMessage[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'run', arguments: {} }] },
      { role: 'tool', content: 'exit 0', toolCallId: 'c1', toolName: 'run' },
      { role: 'user', content: 'Wrap up.' }
    ]
    const out = toGeminiContents(msgs)

    // No two adjacent turns share a role.
    for (let i = 1; i < out.length; i++) {
      expect(out[i].role).not.toBe(out[i - 1].role)
    }
    // model turn, then one user turn carrying both the functionResponse and the nudge.
    expect(out).toEqual([
      { role: 'model', parts: [{ functionCall: { name: 'run', args: {} } }] },
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'run', response: { result: 'exit 0' } } }, { text: 'Wrap up.' }]
      }
    ])
  })

  it('merges parallel tool results into a single user turn', () => {
    const msgs: ChatMessage[] = [
      { role: 'tool', content: 'r1', toolCallId: 'c1', toolName: 'run' },
      { role: 'tool', content: 'r2', toolCallId: 'c2', toolName: 'run' }
    ]
    expect(toGeminiContents(msgs)).toEqual([
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'run', response: { result: 'r1' } } },
          { functionResponse: { name: 'run', response: { result: 'r2' } } }
        ]
      }
    ])
  })

  it('keeps parallel tool results in one turn when an earlier one produced an image', () => {
    // The responses to one model turn's calls must all sit in the next turn. An image
    // turn spliced in after the first result split them (a 400: the response parts no
    // longer match the call parts), so the images wait for the run to end.
    const msgs: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'c1', name: 'view_localhost', arguments: {} },
          { id: 'c2', name: 'run', arguments: {} }
        ]
      },
      {
        role: 'tool',
        content: 'Loaded',
        toolCallId: 'c1',
        toolName: 'view_localhost',
        images: [{ mediaType: 'image/png', data: 'SHOT' }]
      },
      { role: 'tool', content: 'r2', toolCallId: 'c2', toolName: 'run' },
      { role: 'user', content: 'Wrap up.' }
    ]
    expect(toGeminiContents(msgs)).toEqual([
      {
        role: 'model',
        parts: [
          { functionCall: { name: 'view_localhost', args: {} } },
          { functionCall: { name: 'run', args: {} } }
        ]
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'view_localhost', response: { result: 'Loaded' } } },
          { functionResponse: { name: 'run', response: { result: 'r2' } } }
        ]
      },
      { role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'SHOT' } }] },
      { role: 'user', parts: [{ text: 'Wrap up.' }] }
    ])
  })
})

describe('gemini function-call thought signatures', () => {
  beforeEach(() => h.stream.mockReset())

  it('records the signature each function call arrives with, keyed by call id', async () => {
    h.stream.mockResolvedValue(
      (async function* () {
        yield {
          candidates: [
            {
              finishReason: 'STOP',
              content: {
                parts: [
                  { functionCall: { id: 'fc1', name: 'read_file', args: { path: 'a' } }, thoughtSignature: 'SIG1' },
                  { functionCall: { id: 'fc2', name: 'read_file', args: { path: 'b' } } }
                ]
              }
            }
          ]
        }
      })()
    )
    const provider = createGeminiProvider('k')
    let done: ProviderStreamEvent | undefined
    for await (const ev of provider.streamChat({
      model: 'gemini-3.8-flash',
      messages: [{ role: 'user', content: 'hi' }]
    } as ChatRequest)) {
      if (ev.type === 'done') done = ev
    }
    expect(done).toMatchObject({
      stopReason: 'tool_use',
      reasoning: [{ text: '', model: 'gemini-3.8-flash', id: 'fc1', signature: 'SIG1' }]
    })
  })

  it('sends each function call back with its signature, for the model that issued it', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'read both' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'fc1', name: 'read_file', arguments: { path: 'a' } },
          { id: 'fc2', name: 'read_file', arguments: { path: 'b' } }
        ],
        reasoning: [{ text: '', model: 'gemini-3.8-flash', id: 'fc1', signature: 'SIG1' }]
      },
      { role: 'tool', content: 'A', toolCallId: 'fc1', toolName: 'read_file' },
      { role: 'tool', content: 'B', toolCallId: 'fc2', toolName: 'read_file' }
    ]
    expect(toGeminiContents(msgs, 'gemini-3.8-flash')[1]).toEqual({
      role: 'model',
      parts: [
        { functionCall: { name: 'read_file', args: { path: 'a' } }, thoughtSignature: 'SIG1' },
        { functionCall: { name: 'read_file', args: { path: 'b' } } }
      ]
    })
    // Another model can't use the signature, so the calls go back without it.
    expect(toGeminiContents(msgs, 'gemini-4-argon')[1].parts).toEqual([
      { functionCall: { name: 'read_file', args: { path: 'a' } } },
      { functionCall: { name: 'read_file', args: { path: 'b' } } }
    ])
  })

  it('passes the request model through, so replayed signatures reach the API', async () => {
    h.stream.mockResolvedValue((async function* () {})())
    const provider = createGeminiProvider('k')
    const messages: ChatMessage[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'fc1', name: 'run', arguments: {} }],
        reasoning: [{ text: '', model: 'gemini-3.8-flash', id: 'fc1', signature: 'SIG1' }]
      },
      { role: 'tool', content: 'ok', toolCallId: 'fc1', toolName: 'run' }
    ]
    for await (const _ of provider.streamChat({ model: 'gemini-3.8-flash', messages } as ChatRequest)) {
      // drain
    }
    const sent = h.stream.mock.calls[0][0] as { contents: { parts: Record<string, unknown>[] }[] }
    expect(sent.contents[1].parts[0]).toMatchObject({ thoughtSignature: 'SIG1' })
  })
})

describe('gemini maxOutputTokens', () => {
  beforeEach(() => h.stream.mockReset())

  /** Run one turn and return the `config` the adapter sent to the SDK. */
  async function configFor(req: Partial<ChatRequest>): Promise<Record<string, unknown>> {
    h.stream.mockResolvedValue(
      (async function* () {
        yield { candidates: [{ content: { parts: [{ text: 'ok' }] } }] }
      })()
    )
    const provider = createGeminiProvider('k')
    for await (const _ of provider.streamChat({
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'hi' }],
      ...req
    } as ChatRequest) as AsyncGenerator<ProviderStreamEvent>) {
      void _
    }
    const arg = h.stream.mock.calls[0][0] as { config: Record<string, unknown> }
    return arg.config
  }

  it('sends the caller-requested reply cap as maxOutputTokens', async () => {
    expect(await configFor({ maxTokens: 32 })).toMatchObject({ maxOutputTokens: 32 })
  })

  it('omits the cap when the caller sets none (server default applies)', async () => {
    expect(await configFor({})).not.toHaveProperty('maxOutputTokens')
  })

  it('raises a short cap to 32K on Gemini 4, which spends output on thinking', async () => {
    expect(await configFor({ model: 'gemini-4-argon', maxTokens: 64 })).toMatchObject({ maxOutputTokens: 32_768 })
    h.stream.mockReset()
    expect(await configFor({ model: 'gemini-4-argon', maxTokens: 50_000 })).toMatchObject({ maxOutputTokens: 50_000 })
  })
})

describe('gemini thinking config', () => {
  beforeEach(() => h.stream.mockReset())

  async function thinkingFor(model: string, effort: ChatRequest['reasoningEffort']): Promise<unknown> {
    h.stream.mockResolvedValue(
      (async function* () {
        yield { candidates: [{ content: { parts: [{ text: 'ok' }] } }] }
      })()
    )
    for await (const _ of createGeminiProvider('k').streamChat({
      model,
      reasoningEffort: effort,
      messages: [{ role: 'user', content: 'hi' }]
    } as ChatRequest) as AsyncGenerator<ProviderStreamEvent>) {
      void _
    }
    return (h.stream.mock.calls.at(-1)![0] as { config: Record<string, unknown> }).config.thinkingConfig
  }

  it('sends a thinking level on Gemini 4, LOW with thoughts hidden when reasoning is off', async () => {
    expect(await thinkingFor('gemini-4-argon', 'medium')).toEqual({ thinkingLevel: 'MEDIUM', includeThoughts: true })
    expect(await thinkingFor('gemini-4-argon', 'xhigh')).toEqual({ thinkingLevel: 'HIGH', includeThoughts: true })
    expect(await thinkingFor('gemini-4-argon', 'off')).toEqual({ thinkingLevel: 'LOW', includeThoughts: false })
  })

  it('keeps the token budget on 2.5 and 3.x, and sends nothing when off there', async () => {
    expect(await thinkingFor('gemini-3.8-flash', 'high')).toEqual({ thinkingBudget: 16_000, includeThoughts: true })
    expect(await thinkingFor('gemini-3.8-flash', 'off')).toBeUndefined()
  })
})

describe('gemini usage reporting', () => {
  beforeEach(() => h.stream.mockReset())

  async function drainDoneUsage(usageMetadata: Record<string, number>): Promise<Record<string, number>> {
    h.stream.mockResolvedValue(
      (async function* () {
        yield { usageMetadata, candidates: [{ content: { parts: [{ text: 'ok' }] } }] }
      })()
    )
    const provider = createGeminiProvider('k')
    let done: { usage?: Record<string, number> } | undefined
    for await (const ev of provider.streamChat({
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'hi' }]
    } as ChatRequest) as AsyncGenerator<ProviderStreamEvent>) {
      if (ev.type === 'done') done = ev as { usage?: Record<string, number> }
    }
    return done?.usage ?? {}
  }

  it('surfaces implicit-cache hits from cachedContentTokenCount (subset of promptTokenCount)', async () => {
    const usage = await drainDoneUsage({
      promptTokenCount: 5_000,
      candidatesTokenCount: 20,
      cachedContentTokenCount: 4_000
    })
    expect(usage).toEqual({ inputTokens: 5_000, outputTokens: 20, cacheReadTokens: 4_000 })
  })

  it('omits the cache field when no hits are reported', async () => {
    const usage = await drainDoneUsage({ promptTokenCount: 1_000, candidatesTokenCount: 10 })
    expect(usage).toEqual({ inputTokens: 1_000, outputTokens: 10 })
  })

  it('includes thinking tokens in the output count (candidatesTokenCount excludes thoughts)', async () => {
    const usage = await drainDoneUsage({
      promptTokenCount: 100,
      candidatesTokenCount: 20,
      thoughtsTokenCount: 50
    })
    expect(usage).toEqual({ inputTokens: 100, outputTokens: 70 })
  })
})

describe('gemini stop reason', () => {
  beforeEach(() => h.stream.mockReset())

  async function drainStopReason(candidate: Record<string, unknown>): Promise<string | undefined> {
    h.stream.mockResolvedValue(
      (async function* () {
        yield { candidates: [candidate] }
      })()
    )
    const provider = createGeminiProvider('k')
    let stop: string | undefined
    for await (const ev of provider.streamChat({
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'hi' }]
    } as ChatRequest) as AsyncGenerator<ProviderStreamEvent>) {
      if (ev.type === 'done') stop = (ev as { stopReason?: string }).stopReason
    }
    return stop
  }

  it('maps a MAX_TOKENS finish reason to max_tokens (truncated, not a clean end_turn)', async () => {
    expect(await drainStopReason({ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'trunc' }] } })).toBe(
      'max_tokens'
    )
  })

  it('reports a normal STOP finish as end_turn', async () => {
    expect(await drainStopReason({ finishReason: 'STOP', content: { parts: [{ text: 'done' }] } })).toBe(
      'end_turn'
    )
  })
})

describe('modelOptionFromGeminiListing', () => {
  it('strips the models/ prefix and captures inputTokenLimit as the context window', () => {
    expect(
      modelOptionFromGeminiListing({ name: 'models/gemini-2.5-pro', inputTokenLimit: 1048576 })
    ).toEqual({ id: 'gemini-2.5-pro', caps: { contextWindow: 1048576 } })
  })

  it('returns just the id when inputTokenLimit is absent', () => {
    expect(modelOptionFromGeminiListing({ name: 'models/gemini-embedding-001' })).toEqual({
      id: 'gemini-embedding-001'
    })
  })

  it('ignores a non-positive inputTokenLimit', () => {
    expect(modelOptionFromGeminiListing({ name: 'models/a', inputTokenLimit: 0 })).toEqual({
      id: 'a'
    })
    expect(modelOptionFromGeminiListing({ name: 'models/b', inputTokenLimit: -1 })).toEqual({
      id: 'b'
    })
  })

  it('returns null for a nameless entry', () => {
    expect(modelOptionFromGeminiListing({})).toBeNull()
    expect(modelOptionFromGeminiListing({ name: '', inputTokenLimit: 32768 })).toBeNull()
  })
})

describe('listGeminiModels', () => {
  it('maps the pager into ModelOptions, dropping nameless entries', async () => {
    expect(await listGeminiModels('test-key')).toEqual([
      { id: 'gemini-2.5-pro', caps: { contextWindow: 1048576 } },
      { id: 'embedding-001' }
    ])
  })
})

describe('toGeminiContents: consecutive user turns', () => {
  it('folds a plain user turn onto the one before it', () => {
    const out = toGeminiContents([
      { role: 'user', content: 'note' },
      { role: 'user', content: 'question' }
    ])
    expect(out).toEqual([{ role: 'user', parts: [{ text: 'note' }, { text: 'question' }] }])
  })

  it('never folds onto a turn of function responses or the media split from one', () => {
    const out = toGeminiContents([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'read_file', arguments: {} }] },
      { role: 'tool', content: 'ok', toolCallId: 'c', toolName: 'read_file' },
      { role: 'user', content: '', images: [{ mediaType: 'image/png', data: 'AAA' }] },
      { role: 'user', content: 'and this' }
    ])
    const last = out[out.length - 1]
    expect(out.filter((c) => c.parts?.some((p) => 'functionResponse' in p))[0].parts?.some((p) => 'inlineData' in p)).toBe(false)
    // The media split off a tool-result turn stays its own turn, and the next message
    // doesn't fold into it (the same rule as a tool's own images).
    expect(last.parts).toEqual([{ text: 'and this' }])
    expect(out[out.length - 2].parts?.every((p) => 'inlineData' in p)).toBe(true)
  })
})
