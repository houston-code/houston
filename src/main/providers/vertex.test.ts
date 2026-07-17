import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ChatRequest } from '@shared/agent'
import { createVertexProvider, listVertexModels } from './vertex'

/**
 * Vertex rides the shared Anthropic adapter, so this covers what's specific to it:
 * the options handed to `AnthropicVertex`, the curated model list, and — the case
 * worth the most here — that Vertex's `@`-dated snapshot ids still resolve the
 * thinking gates. A dated 4.0 id that misses the legacy gate gets sent adaptive
 * thinking and the API rejects the turn, which no type or compile check would catch.
 */

const h = vi.hoisted(() => ({ stream: vi.fn(), ctor: vi.fn() }))
vi.mock('@anthropic-ai/vertex-sdk', () => {
  class FakeAnthropicVertex {
    messages = { stream: h.stream }
    constructor(opts: unknown) {
      h.ctor(opts)
    }
  }
  return { AnthropicVertex: FakeAnthropicVertex }
})

function fakeStream(): unknown {
  return {
    async *[Symbol.asyncIterator]() {
      // no events — these tests assert on the request, not the response
    },
    finalMessage: async () => ({
      content: [],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 }
    })
  }
}

/** Drive one turn and return [constructor options, request body]. */
async function run(
  opts: Parameters<typeof createVertexProvider>[0],
  req: Partial<ChatRequest> & { model: string }
): Promise<{ ctorOpts: Record<string, unknown>; body: Record<string, unknown> }> {
  h.stream.mockReturnValue(fakeStream())
  const provider = createVertexProvider(opts)
  const gen = provider.streamChat({ messages: [{ role: 'user', content: 'hi' }], ...req } as ChatRequest)
  while (!(await gen.next()).done) {
    /* drain */
  }
  return {
    ctorOpts: h.ctor.mock.calls.at(-1)![0] as Record<string, unknown>,
    body: h.stream.mock.calls.at(-1)![0] as Record<string, unknown>
  }
}

describe('createVertexProvider client options', () => {
  beforeEach(() => {
    h.stream.mockReset()
    h.ctor.mockReset()
  })

  it('passes the region and project through', async () => {
    const { ctorOpts } = await run(
      { region: 'us-east5', projectId: 'my-project' },
      { model: 'claude-opus-4-8' }
    )
    expect(ctorOpts.region).toBe('us-east5')
    expect(ctorOpts.projectId).toBe('my-project')
  })

  it('omits a blank project so the SDK can infer it from the credentials', async () => {
    const { ctorOpts } = await run({ region: 'us-east5' }, { model: 'claude-opus-4-8' })
    expect('projectId' in ctorOpts).toBe(false)
    // Nothing beyond the region and the auth suppression below.
    expect(ctorOpts).toEqual({ region: 'us-east5', apiKey: null, authToken: null })
  })

  it('nulls out the inherited first-party credentials so the env cannot leak to Google', async () => {
    // `BaseAnthropic` resolves apiKey/authToken from ANTHROPIC_API_KEY /
    // ANTHROPIC_AUTH_TOKEN whenever they are left undefined, and AnthropicVertex
    // does not override authHeaders(). Omitting these would send a first-party
    // Anthropic key to Google as `x-api-key` on every request. Explicit nulls are
    // the fix, so they must actually reach the constructor.
    const { ctorOpts } = await run({ region: 'us-east5' }, { model: 'claude-opus-4-8' })
    expect(ctorOpts.apiKey).toBeNull()
    expect(ctorOpts.authToken).toBeNull()
  })

  it('builds the client once across turns', async () => {
    h.stream.mockReturnValue(fakeStream())
    const provider = createVertexProvider({ region: 'us-east5' })
    for (let i = 0; i < 2; i++) {
      const gen = provider.streamChat({
        model: 'claude-opus-4-8',
        messages: [{ role: 'user', content: 'hi' }]
      } as ChatRequest)
      while (!(await gen.next()).done) {
        /* drain */
      }
    }
    expect(h.ctor).toHaveBeenCalledTimes(1)
  })
})

describe('vertex reuses the Anthropic adapter', () => {
  beforeEach(() => {
    h.stream.mockReset()
    h.ctor.mockReset()
  })

  it('sends a dated snapshot id verbatim, @ and all', async () => {
    const { body } = await run({ region: 'us-east5' }, { model: 'claude-opus-4-5@20251101' })
    expect(body.model).toBe('claude-opus-4-5@20251101')
  })

  it('applies adaptive thinking to Opus 4.8', async () => {
    const { body } = await run(
      { region: 'us-east5' },
      { model: 'claude-opus-4-8', reasoningEffort: 'xhigh' }
    )
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(body.output_config).toEqual({ effort: 'xhigh' })
  })

  it('applies legacy budget thinking to an @-dated Sonnet 4.0 snapshot', async () => {
    // The regression this file exists for: `claude-sonnet-4@20250514` is the same
    // model as `claude-sonnet-4-20250514`, and the gate keyed on the `-` separator
    // alone, so Vertex's form silently fell through to adaptive thinking (a 400).
    const { body } = await run(
      { region: 'us-east5' },
      { model: 'claude-sonnet-4@20250514', reasoningEffort: 'medium' }
    )
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 10_000 })
    expect(body.output_config).toBeUndefined()
  })

  it('still sets prompt-cache breakpoints', async () => {
    const { body } = await run(
      { region: 'us-east5' },
      { model: 'claude-opus-4-8', system: 'sys' }
    )
    const system = body.system as Array<{ cache_control?: unknown }>
    expect(system[0].cache_control).toEqual({ type: 'ephemeral' })
  })
})

describe('listVertexModels', () => {
  beforeEach(() => h.ctor.mockReset())

  it('returns bare curated Claude ids without touching the network', () => {
    const models = listVertexModels()
    expect(models.length).toBeGreaterThan(0)
    // Vertex takes the plain id — a Bedrock-style vendor prefix would 404 here.
    for (const m of models) expect(m.id).toMatch(/^claude-/)
    expect(h.ctor).not.toHaveBeenCalled()
  })
})
