import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ChatRequest } from '@shared/agent'
import { DEFAULT_AZURE_API_VERSION } from '@shared/provider-catalog'
import { azureBaseUrl, createAzureOpenAIProvider, listAzureOpenAIModels } from './azure'

/**
 * Azure OpenAI rides the shared Chat Completions adapter, so this covers what's
 * specific to it: the options handed to `AzureOpenAI`, the deployment-shaped model
 * list, and that an exported `OPENAI_*` variable can't break or redirect a provider
 * the user configured in Settings. The last describe block checks that against the
 * *real* SDK, because the assumption that would break is the SDK's, and no mock of
 * ours can falsify it.
 */

const h = vi.hoisted(() => ({ create: vi.fn(), ctor: vi.fn() }))
vi.mock('openai', () => {
  class FakeAzureOpenAI {
    chat = { completions: { create: h.create } }
    constructor(opts: unknown) {
      h.ctor(opts)
    }
  }
  return { AzureOpenAI: FakeAzureOpenAI, default: class {} }
})

function fakeStream(): unknown {
  return {
    async *[Symbol.asyncIterator]() {
      // no chunks — these tests assert on the request, not the response
    }
  }
}

/** Drive one turn and return [constructor options, request body]. */
async function run(
  opts: Parameters<typeof createAzureOpenAIProvider>[0],
  req: Partial<ChatRequest> & { model: string }
): Promise<{ ctorOpts: Record<string, unknown>; body: Record<string, unknown> }> {
  h.create.mockResolvedValue(fakeStream())
  const provider = createAzureOpenAIProvider(opts)
  const gen = provider.streamChat({
    messages: [{ role: 'user', content: 'hi' }],
    ...req
  } as ChatRequest)
  while (!(await gen.next()).done) {
    /* drain */
  }
  return {
    ctorOpts: h.ctor.mock.calls.at(-1)![0] as Record<string, unknown>,
    body: h.create.mock.calls.at(-1)![0] as Record<string, unknown>
  }
}

describe('createAzureOpenAIProvider client options', () => {
  beforeEach(() => {
    h.create.mockReset()
    h.ctor.mockReset()
    vi.unstubAllEnvs()
  })

  it('derives the base URL from the endpoint and passes the key', async () => {
    const { ctorOpts } = await run(
      { endpoint: 'https://my-resource.openai.azure.com', apiKey: 'azure-key' },
      { model: 'my-deployment' }
    )
    expect(ctorOpts.baseURL).toBe('https://my-resource.openai.azure.com/openai')
    expect(ctorOpts.apiKey).toBe('azure-key')
  })

  it('never passes `endpoint`, which the SDK rejects alongside a base URL', async () => {
    // The SDK resolves baseURL from OPENAI_BASE_URL as a default parameter and then
    // rejects `endpoint` next to it. We always pass an explicit baseURL, so passing
    // `endpoint` too would throw on any machine with OPENAI_BASE_URL exported.
    const { ctorOpts } = await run(
      { endpoint: 'https://my-resource.openai.azure.com', apiKey: 'k' },
      { model: 'd' }
    )
    expect('endpoint' in ctorOpts).toBe(false)
  })

  it('tolerates a trailing slash on the endpoint', async () => {
    expect(azureBaseUrl({ endpoint: 'https://my-resource.openai.azure.com/' })).toBe(
      'https://my-resource.openai.azure.com/openai'
    )
  })

  it('lets an explicit base URL win over the endpoint, for a gateway', async () => {
    expect(
      azureBaseUrl({ endpoint: 'https://my-resource.openai.azure.com', baseUrl: 'https://gw/openai' })
    ).toBe('https://gw/openai')
  })

  it('honors the SDK endpoint env var when Settings leaves the field blank', () => {
    vi.stubEnv('AZURE_OPENAI_ENDPOINT', 'https://env-resource.openai.azure.com')
    expect(azureBaseUrl({})).toBe('https://env-resource.openai.azure.com/openai')
  })

  it('has no address when nothing is configured', () => {
    expect(azureBaseUrl({})).toBeUndefined()
  })

  it('defaults the API version, and lets the user override it', async () => {
    const { ctorOpts } = await run({ endpoint: 'https://r.openai.azure.com', apiKey: 'k' }, { model: 'd' })
    expect(ctorOpts.apiVersion).toBe(DEFAULT_AZURE_API_VERSION)

    const custom = await run(
      { endpoint: 'https://r.openai.azure.com', apiKey: 'k', apiVersion: '2025-01-01-preview' },
      { model: 'd' }
    )
    expect(custom.ctorOpts.apiVersion).toBe('2025-01-01-preview')
  })

  it('never pins a deployment, so each model routes to its own', async () => {
    // The SDK falls back to the request's `model` as the deployment name when the
    // client pins none. Pinning one would send every model in the provider's list to
    // a single deployment, silently ignoring the user's choice in the model picker.
    const { ctorOpts } = await run(
      { endpoint: 'https://r.openai.azure.com', apiKey: 'k' },
      { model: 'my-gpt5-deployment' }
    )
    expect('deployment' in ctorOpts).toBe(false)
  })

  it('builds the client once across turns', async () => {
    h.create.mockResolvedValue(fakeStream())
    const provider = createAzureOpenAIProvider({ endpoint: 'https://r.openai.azure.com', apiKey: 'k' })
    for (let i = 0; i < 2; i++) {
      const gen = provider.streamChat({
        model: 'd',
        messages: [{ role: 'user', content: 'hi' }]
      } as ChatRequest)
      while (!(await gen.next()).done) {
        /* drain */
      }
    }
    expect(h.ctor).toHaveBeenCalledTimes(1)
  })
})

describe('azure reuses the Chat Completions adapter', () => {
  beforeEach(() => {
    h.create.mockReset()
    h.ctor.mockReset()
  })

  it('sends the deployment name as the model, verbatim', async () => {
    const { body } = await run(
      { endpoint: 'https://r.openai.azure.com', apiKey: 'k' },
      { model: 'My_GPT5-Deploy.01' }
    )
    expect(body.model).toBe('My_GPT5-Deploy.01')
  })

  it('streams and asks for the usage chunk', async () => {
    const { body } = await run({ endpoint: 'https://r.openai.azure.com', apiKey: 'k' }, { model: 'd' })
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
  })

  it('passes tools through in OpenAI function form', async () => {
    const { body } = await run(
      { endpoint: 'https://r.openai.azure.com', apiKey: 'k' },
      {
        model: 'd',
        tools: [{ name: 'read_file', description: 'Read', parameters: { type: 'object' } }]
      } as Partial<ChatRequest> & { model: string }
    )
    const tools = body.tools as { type: string; function: { name: string } }[]
    expect(tools[0]).toMatchObject({ type: 'function', function: { name: 'read_file' } })
  })
})

describe('listAzureOpenAIModels', () => {
  beforeEach(() => h.ctor.mockReset())

  it('echoes the configured deployments without touching the network', () => {
    // Nothing to fetch and nothing to curate: the ids are names the user chose.
    const models = listAzureOpenAIModels([{ id: 'my-gpt5' }, { id: 'my-gpt4o' }])
    expect(models).toEqual([{ id: 'my-gpt5' }, { id: 'my-gpt4o' }])
    expect(h.ctor).not.toHaveBeenCalled()
  })

  it('preserves capability metadata the user configured', () => {
    expect(listAzureOpenAIModels([{ id: 'd', caps: { vision: true } }])).toEqual([
      { id: 'd', caps: { vision: true } }
    ])
  })

  it('returns nothing for a provider with no deployments yet', () => {
    expect(listAzureOpenAIModels([])).toEqual([])
  })
})

describe('the real SDK accepts what the adapter passes', () => {
  /**
   * The mocked tests above pin the options we send; these pin that those options mean
   * what we think against the actual `AzureOpenAI`. Hostile env throughout — a
   * first-party OpenAI key plus a proxy base URL, exactly the machine where a wrong
   * assumption about the SDK's env handling would surface.
   */
  beforeEach(() => {
    h.ctor.mockReset()
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai-first-party-should-not-leak')
    vi.stubEnv('OPENAI_BASE_URL', 'https://my-proxy.example.com/v1')
    vi.stubEnv('AZURE_OPENAI_ENDPOINT', 'https://ambient.openai.azure.com')
  })

  it('routes each model to its deployment and sends only the Azure key', async () => {
    const { ctorOpts } = await run(
      { endpoint: 'https://my-resource.openai.azure.com', apiKey: 'azure-key' },
      { model: 'my-deployment' }
    )

    const requests: { url: string; headers: Record<string, string> }[] = []
    const actual = (await vi.importActual('openai')) as {
      AzureOpenAI: new (o: unknown) => {
        chat: { completions: { create: (b: unknown) => Promise<unknown> } }
      }
    }
    // The exact options the adapter built, handed to the real constructor.
    const client = new actual.AzureOpenAI({
      ...ctorOpts,
      fetch: async (url: string, init: { headers?: HeadersInit }) => {
        const headers: Record<string, string> = {}
        new Headers(init?.headers).forEach((v, k) => (headers[k] = v))
        requests.push({ url: String(url), headers })
        return new Response(JSON.stringify({ id: 'c', choices: [], created: 0, model: 'm' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
    })
    await client.chat.completions.create({
      model: 'my-deployment',
      messages: [{ role: 'user', content: 'hi' }]
    })

    const sent = requests.at(-1)!
    // The ambient OPENAI_BASE_URL/AZURE_OPENAI_ENDPOINT did not redirect the request,
    // and neither made the constructor throw "mutually exclusive".
    expect(sent.url).toBe(
      `https://my-resource.openai.azure.com/openai/deployments/my-deployment/chat/completions?api-version=${DEFAULT_AZURE_API_VERSION}`
    )
    // Azure's own header, not `Authorization: Bearer`.
    expect(sent.headers['api-key']).toBe('azure-key')
    // The first-party env key never reached the wire, in any header.
    expect(JSON.stringify(sent.headers)).not.toContain('first-party')
  })
})
