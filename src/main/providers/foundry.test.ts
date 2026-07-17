import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ChatRequest } from '@shared/agent'
import { createFoundryProvider, foundryBaseUrl, listFoundryModels } from './foundry'

/**
 * Foundry rides the shared Anthropic adapter, so this covers what's specific to it:
 * the options handed to `AnthropicFoundry`, the curated model list, and — the case
 * worth the most here — that an exported `ANTHROPIC_FOUNDRY_*` variable can't break
 * or redirect a provider the user configured in Settings. The last describe block
 * checks that against the *real* SDK, because the assumption that would break is the
 * SDK's, and no mock of ours can falsify it.
 */

const h = vi.hoisted(() => ({ stream: vi.fn(), ctor: vi.fn() }))
vi.mock('@anthropic-ai/foundry-sdk', () => {
  class FakeAnthropicFoundry {
    messages = { stream: h.stream }
    constructor(opts: unknown) {
      h.ctor(opts)
    }
  }
  return { AnthropicFoundry: FakeAnthropicFoundry }
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
  opts: Parameters<typeof createFoundryProvider>[0],
  req: Partial<ChatRequest> & { model: string }
): Promise<{ ctorOpts: Record<string, unknown>; body: Record<string, unknown> }> {
  h.stream.mockReturnValue(fakeStream())
  const provider = createFoundryProvider(opts)
  const gen = provider.streamChat({
    messages: [{ role: 'user', content: 'hi' }],
    ...req
  } as ChatRequest)
  while (!(await gen.next()).done) {
    /* drain */
  }
  return {
    ctorOpts: h.ctor.mock.calls.at(-1)![0] as Record<string, unknown>,
    body: h.stream.mock.calls.at(-1)![0] as Record<string, unknown>
  }
}

describe('createFoundryProvider client options', () => {
  beforeEach(() => {
    h.stream.mockReset()
    h.ctor.mockReset()
    vi.unstubAllEnvs()
  })

  it('derives the resource endpoint and passes the key', async () => {
    const { ctorOpts } = await run(
      { resource: 'my-resource', apiKey: 'foundry-key' },
      { model: 'claude-opus-4-8' }
    )
    expect(ctorOpts.baseURL).toBe('https://my-resource.services.ai.azure.com/anthropic/')
    expect(ctorOpts.apiKey).toBe('foundry-key')
  })

  it('lets an explicit base URL win over the resource, for a gateway', async () => {
    const { ctorOpts } = await run(
      { resource: 'my-resource', baseUrl: 'https://gw.example.com/anthropic/', apiKey: 'k' },
      { model: 'claude-opus-4-8' }
    )
    expect(ctorOpts.baseURL).toBe('https://gw.example.com/anthropic/')
  })

  it('blanks the resource so the SDK cannot read it from the environment', async () => {
    // `AnthropicFoundry` resolves `resource` from ANTHROPIC_FOUNDRY_RESOURCE as a
    // default parameter, then rejects the explicit baseURL we always pass alongside
    // it ("baseURL and resource are mutually exclusive"). A defined value stops the
    // default from firing; '' is also falsy enough to skip the exclusion check.
    // Dropping this line makes every run fail on a machine with that var exported.
    const { ctorOpts } = await run({ resource: 'my-resource', apiKey: 'k' }, { model: 'claude-opus-4-8' })
    expect(ctorOpts.resource).toBe('')
  })

  it('honors the SDK resource env var when Settings leaves the field blank', async () => {
    vi.stubEnv('ANTHROPIC_FOUNDRY_RESOURCE', 'env-resource')
    // Resolved by us rather than the SDK, precisely because we blank the option above.
    expect(foundryBaseUrl({})).toBe('https://env-resource.services.ai.azure.com/anthropic/')
  })

  it('has no address when nothing is configured', () => {
    expect(foundryBaseUrl({})).toBeUndefined()
  })

  it('builds the client once across turns', async () => {
    h.stream.mockReturnValue(fakeStream())
    const provider = createFoundryProvider({ resource: 'my-resource', apiKey: 'k' })
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

describe('foundry reuses the Anthropic adapter', () => {
  beforeEach(() => {
    h.stream.mockReset()
    h.ctor.mockReset()
  })

  it('applies adaptive thinking to Opus 4.8', async () => {
    const { body } = await run(
      { resource: 'r', apiKey: 'k' },
      { model: 'claude-opus-4-8', reasoningEffort: 'xhigh' }
    )
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(body.output_config).toEqual({ effort: 'xhigh' })
  })

  it('still sets prompt-cache breakpoints', async () => {
    const { body } = await run({ resource: 'r', apiKey: 'k' }, { model: 'claude-opus-4-8', system: 'sys' })
    const system = body.system as Array<{ cache_control?: unknown }>
    expect(system[0].cache_control).toEqual({ type: 'ephemeral' })
  })
})

describe('listFoundryModels', () => {
  beforeEach(() => h.ctor.mockReset())

  it('returns bare curated Claude ids without touching the network', () => {
    const models = listFoundryModels()
    expect(models.length).toBeGreaterThan(0)
    // Foundry takes the plain id — a Bedrock-style vendor prefix would not resolve.
    for (const m of models) expect(m.id).toMatch(/^claude-/)
    expect(h.ctor).not.toHaveBeenCalled()
  })
})

describe('the real SDK accepts what the adapter passes', () => {
  /**
   * The mocked tests above pin the options we send; these pin that those options mean
   * what we think against the actual `AnthropicFoundry`. That distinction is not
   * academic: the equivalent Vertex bug was a wrong belief about the SDK's env
   * handling, which every mock in the suite happily agreed with. Hostile env
   * throughout — a first-party Anthropic key plus Foundry's own variables, exactly
   * the machine where the assumption breaks.
   */
  beforeEach(() => {
    h.ctor.mockReset()
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-first-party-should-not-leak')
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'first-party-token-should-not-leak')
    vi.stubEnv('ANTHROPIC_FOUNDRY_RESOURCE', 'ambient-resource')
    vi.stubEnv('ANTHROPIC_FOUNDRY_BASE_URL', 'https://ambient.example.com/anthropic/')
  })

  it('addresses the configured resource and sends only the Foundry key', async () => {
    const { ctorOpts } = await run(
      { resource: 'my-resource', apiKey: 'foundry-key' },
      { model: 'claude-opus-4-8' }
    )

    const requests: { url: string; headers: Record<string, string> }[] = []
    const actual = (await vi.importActual('@anthropic-ai/foundry-sdk')) as {
      AnthropicFoundry: new (o: unknown) => {
        messages: { create: (b: unknown) => Promise<unknown> }
      }
    }
    // The exact options the adapter built, handed to the real constructor.
    const client = new actual.AnthropicFoundry({
      ...ctorOpts,
      fetch: async (url: string, init: { headers?: HeadersInit }) => {
        const headers: Record<string, string> = {}
        new Headers(init?.headers).forEach((v, k) => (headers[k] = v))
        requests.push({ url: String(url), headers })
        return new Response(
          JSON.stringify({
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            model: 'claude-opus-4-8',
            content: [],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
    })
    await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }]
    })

    const sent = requests.at(-1)!
    // The ambient ANTHROPIC_FOUNDRY_BASE_URL/_RESOURCE did not redirect the request,
    // and neither made the constructor throw "mutually exclusive".
    expect(sent.url).toBe('https://my-resource.services.ai.azure.com/anthropic/v1/messages')
    expect(sent.headers['x-api-key']).toBe('foundry-key')
    // The first-party env credentials never reached the wire, in any header.
    const wire = JSON.stringify(sent.headers)
    expect(wire).not.toContain('first-party')
  })
})
