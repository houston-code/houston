import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ChatRequest } from '@shared/agent'
import { createBedrockProvider, explainLegacyModelError, listBedrockModels, predatesClaude47 } from './bedrock'
import { ProviderError } from '../agent/retry'

/**
 * Bedrock rides the shared Anthropic adapter, so these tests cover the two things
 * that are actually this file's own: the options handed to the Mantle client, and
 * the curated model list. The "reuses the Anthropic adapter" cases below are the
 * load-bearing ones — they're what would catch the refactor seam breaking and each
 * host quietly losing thinking or prompt caching.
 */

const h = vi.hoisted(() => ({ stream: vi.fn(), ctor: vi.fn() }))
vi.mock('@anthropic-ai/bedrock-sdk', () => {
  class FakeAnthropicBedrockMantle {
    messages = { stream: h.stream }
    constructor(opts: unknown) {
      h.ctor(opts)
    }
  }
  return { AnthropicBedrockMantle: FakeAnthropicBedrockMantle }
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
  opts: Parameters<typeof createBedrockProvider>[0],
  req: Partial<ChatRequest> & { model: string }
): Promise<{ ctorOpts: Record<string, unknown>; body: Record<string, unknown> }> {
  h.stream.mockReturnValue(fakeStream())
  const provider = createBedrockProvider(opts)
  const gen = provider.streamChat({ messages: [{ role: 'user', content: 'hi' }], ...req } as ChatRequest)
  while (!(await gen.next()).done) {
    /* drain */
  }
  return {
    ctorOpts: h.ctor.mock.calls.at(-1)![0] as Record<string, unknown>,
    body: h.stream.mock.calls.at(-1)![0] as Record<string, unknown>
  }
}

describe('createBedrockProvider client options', () => {
  beforeEach(() => {
    h.stream.mockReset()
    h.ctor.mockReset()
  })

  it('maps the configured region onto awsRegion', async () => {
    const { ctorOpts } = await run({ region: 'eu-west-1' }, { model: 'anthropic.claude-opus-4-8' })
    expect(ctorOpts.awsRegion).toBe('eu-west-1')
  })

  it('omits every option the user did not set, so the SDK resolves its own defaults', async () => {
    // Passing awsRegion: undefined would override the SDK's AWS_REGION fallback. The
    // only option always set is the idle-timeout fetch.
    const { ctorOpts } = await run({}, { model: 'anthropic.claude-opus-4-8' })
    expect(ctorOpts).toEqual({ fetch: expect.any(Function) })
  })

  it('omits an empty apiKey rather than sending one', async () => {
    // The bearer key takes precedence over AWS credentials inside the SDK, so an
    // empty string here would suppress SigV4 and leave the client unauthenticated.
    const { ctorOpts } = await run(
      { region: 'us-east-1', apiKey: '' },
      { model: 'anthropic.claude-opus-4-8' }
    )
    expect('apiKey' in ctorOpts).toBe(false)
  })

  it('passes a stored bearer key through when there is one', async () => {
    const { ctorOpts } = await run(
      { region: 'us-east-1', apiKey: 'bedrock-key' },
      { model: 'anthropic.claude-opus-4-8' }
    )
    expect(ctorOpts.apiKey).toBe('bedrock-key')
  })

  it('passes a base URL override and custom headers', async () => {
    const { ctorOpts } = await run(
      { baseUrl: 'https://gateway.internal/anthropic', headers: { 'X-Trace': '1' } },
      { model: 'anthropic.claude-opus-4-8' }
    )
    expect(ctorOpts.baseURL).toBe('https://gateway.internal/anthropic')
    expect(ctorOpts.defaultHeaders).toEqual({ 'X-Trace': '1' })
  })

  it('builds the client once across turns', async () => {
    h.stream.mockReturnValue(fakeStream())
    const provider = createBedrockProvider({ region: 'us-east-1' })
    for (let i = 0; i < 2; i++) {
      const gen = provider.streamChat({
        model: 'anthropic.claude-opus-4-8',
        messages: [{ role: 'user', content: 'hi' }]
      } as ChatRequest)
      while (!(await gen.next()).done) {
        /* drain */
      }
    }
    expect(h.ctor).toHaveBeenCalledTimes(1)
  })
})

describe('bedrock reuses the Anthropic adapter', () => {
  beforeEach(() => {
    h.stream.mockReset()
    h.ctor.mockReset()
  })

  it('sends the model id verbatim, vendor prefix and all', async () => {
    const { body } = await run({ region: 'us-east-1' }, { model: 'anthropic.claude-opus-4-8' })
    expect(body.model).toBe('anthropic.claude-opus-4-8')
  })

  it('applies adaptive thinking to a prefixed Opus 4.8 id', async () => {
    // The thinking gates match on a substring, so the vendor prefix must not stop
    // them resolving — sending the legacy budget shape here is a 400.
    const { body } = await run(
      { region: 'us-east-1' },
      { model: 'anthropic.claude-opus-4-8', reasoningEffort: 'high' }
    )
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(body.output_config).toEqual({ effort: 'high' })
  })

  it('applies legacy budget thinking to a prefixed Opus 4.5 id', async () => {
    const { body } = await run(
      { region: 'us-east-1' },
      { model: 'anthropic.claude-opus-4-5', reasoningEffort: 'low' }
    )
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 })
    expect(body.output_config).toBeUndefined()
  })

  it('still sets prompt-cache breakpoints', async () => {
    const { body } = await run(
      { region: 'us-east-1' },
      {
        model: 'anthropic.claude-opus-4-8',
        system: 'sys',
        tools: [{ name: 't', description: 'd', parameters: { type: 'object' } }]
      }
    )
    const system = body.system as Array<{ cache_control?: unknown }>
    const tools = body.tools as Array<{ cache_control?: unknown }>
    expect(system[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(tools[tools.length - 1].cache_control).toEqual({ type: 'ephemeral' })
  })
})

describe('listBedrockModels', () => {
  beforeEach(() => h.ctor.mockReset())

  it('returns the curated prefixed ids without touching the network', async () => {
    const models = listBedrockModels()
    expect(models.length).toBeGreaterThan(0)
    for (const m of models) expect(m.id).toMatch(/^anthropic\.claude-/)
    // No client is constructed: there is no Models API to call.
    expect(h.ctor).not.toHaveBeenCalled()
  })
})

describe('pre-4.7 models on Bedrock', () => {
  it('recognizes Claude 3.x and 4.x through 4.6, in every id shape', () => {
    for (const id of [
      'anthropic.claude-sonnet-4-6',
      'anthropic.claude-opus-4-6',
      'anthropic.claude-haiku-4-5',
      'anthropic.claude-opus-4-1',
      'us.anthropic.claude-sonnet-4-20250514-v1:0',
      'anthropic.claude-3-5-sonnet-20240620-v1:0',
      'anthropic.claude-3-haiku-20240307-v1:0'
    ]) {
      expect(predatesClaude47(id), id).toBe(true)
    }
  })

  it('leaves 4.7 and later alone', () => {
    for (const id of [
      'anthropic.claude-opus-4-7',
      'anthropic.claude-opus-4-8',
      'anthropic.claude-opus-5-5',
      'anthropic.claude-sonnet-5-5',
      'anthropic.claude-haiku-5-5',
      'anthropic.claude-fable-5-2',
      ...listBedrockModels().map((m) => m.id)
    ]) {
      expect(predatesClaude47(id), id).toBe(false)
    }
  })

  it('explains a 400 for an older model, keeping the original message and status', () => {
    const err = Object.assign(new Error('400 invalid anthropic_version'), { status: 400 })
    const out = explainLegacyModelError(err, 'anthropic.claude-sonnet-4-6') as ProviderError
    expect(out).toBeInstanceOf(ProviderError)
    expect(out.status).toBe(400)
    expect(out.message).toContain('400 invalid anthropic_version')
    expect(out.message).toContain('Claude 4.7 and later')
    expect(out.message).toContain('anthropic.claude-sonnet-4-6')
  })

  it('passes every other error through untouched', () => {
    const rateLimited = Object.assign(new Error('429'), { status: 429 })
    expect(explainLegacyModelError(rateLimited, 'anthropic.claude-sonnet-4-6')).toBe(rateLimited)
    const badRequest = Object.assign(new Error('400'), { status: 400 })
    expect(explainLegacyModelError(badRequest, 'anthropic.claude-opus-5-5')).toBe(badRequest)
    const network = new Error('fetch failed')
    expect(explainLegacyModelError(network, 'anthropic.claude-sonnet-4-6')).toBe(network)
  })

  it('applies to errors thrown from a real turn', async () => {
    h.stream.mockReset()
    h.stream.mockImplementation(() => {
      throw Object.assign(new Error('400 bad version'), { status: 400 })
    })
    const gen = createBedrockProvider({ region: 'us-east-1' }).streamChat({
      model: 'anthropic.claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }]
    } as ChatRequest)
    await expect(gen.next()).rejects.toThrow(/Claude 4\.7 and later/)
  })
})
