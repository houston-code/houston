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
