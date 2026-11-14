import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Provider } from '@shared/agent'
import type { ProviderKind } from '@shared/types'
import { isQuotaExhaustedError, isRetryableError, retryAfterHintMs } from '../agent/retry'
import { GEMINI_PER_DAY_QUOTA_ID, GEMINI_PER_MINUTE_QUOTA_ID, geminiQuotaBody } from '../test/gemini-errors'
import { createAnthropicProvider, listAnthropicModels } from './anthropic'
import { createAzureOpenAIProvider } from './azure'
import { createBedrockProvider } from './bedrock'
import { createFoundryProvider } from './foundry'
import { createGeminiProvider, listGeminiModels } from './gemini'
import { createOpenAIProvider, listOpenAIModels } from './openai'
import { createResponsesProvider } from './responses'
import { createVertexProvider } from './vertex'

/**
 * Houston's RetryBudget (agent/retry.ts) must be the only retry layer. Each SDK retries
 * 408/409/429/5xx and connection errors on its own by default, out of sight: no `retry`
 * event reaches the user, a 503 costs three requests per Houston attempt, and the
 * Anthropic SDK sleeps out any `retry-after` uncapped (an hour, for `retry-after: 3600`).
 *
 * These drive the REAL SDK clients and adapters against a local server, so an SDK
 * upgrade that changes its retry defaults, or a new adapter that forgets to turn them
 * off, fails here. The table is keyed by every ProviderKind, so a new kind is a compile
 * error until it is listed.
 */

// Google ADC would read this machine's gcloud credentials or call the metadata server.
// A fixed token keeps the test hermetic while the SDK's own request and retry path runs.
vi.mock('@anthropic-ai/vertex-sdk', async (importOriginal) => {
  const real = await importOriginal<typeof import('@anthropic-ai/vertex-sdk')>()
  const authClient = {
    projectId: 'test-project',
    getRequestHeaders: async () => new Headers({ authorization: 'Bearer test-token' })
  }
  class HermeticVertex extends real.AnthropicVertex {
    constructor(opts: ConstructorParameters<typeof real.AnthropicVertex>[0]) {
      super({ ...opts, authClient: authClient as never })
    }
  }
  return { ...real, AnthropicVertex: HermeticVertex }
})

interface StubServer {
  url: string
  requests(): number
  close(): Promise<void>
}

/** A server that answers every request with the same status, headers and JSON body. */
async function answerEvery(status: number, headers: Record<string, string>, body: unknown): Promise<StubServer> {
  let n = 0
  const server = createServer((req, res) => {
    n++
    req.resume()
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(JSON.stringify(body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests: () => n,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

type Family = 'anthropic' | 'openai' | 'gemini'

const ERROR_BODIES: Record<Family, { rateLimited: unknown; overloaded: unknown }> = {
  anthropic: {
    rateLimited: { type: 'error', error: { type: 'rate_limit_error', message: 'Number of requests has exceeded your rate limit' } },
    overloaded: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }
  },
  openai: {
    rateLimited: { error: { message: 'Rate limit reached for requests', type: 'requests', code: 'rate_limit_exceeded' } },
    overloaded: { error: { message: 'Service unavailable', type: 'server_error' } }
  },
  gemini: {
    // Gemini's ApiError carries no headers, so its wait rides the RetryInfo detail.
    rateLimited: {
      error: {
        code: 429,
        message: 'Resource has been exhausted (e.g. check quota).',
        status: 'RESOURCE_EXHAUSTED',
        details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '3600s' }]
      }
    },
    overloaded: { error: { code: 503, message: 'The model is overloaded. Please try again later.', status: 'UNAVAILABLE' } }
  }
}

const ADAPTERS: Record<ProviderKind, { family: Family; model: string; make: (url: string) => Provider }> = {
  anthropic: { family: 'anthropic', model: 'claude-opus-4-8', make: (url) => createAnthropicProvider('k', url) },
  foundry: { family: 'anthropic', model: 'claude-opus-4-8', make: (url) => createFoundryProvider({ apiKey: 'k', baseUrl: url }) },
  bedrock: { family: 'anthropic', model: 'claude-opus-4-8', make: (url) => createBedrockProvider({ apiKey: 'k', baseUrl: url }) },
  vertex: {
    family: 'anthropic',
    model: 'claude-opus-4-8',
    make: (url) => createVertexProvider({ region: 'us-east5', projectId: 'test-project', baseUrl: url })
  },
  // The native OpenAI kind streams over the Responses API.
  openai: { family: 'openai', model: 'gpt-test', make: (url) => createResponsesProvider('k', `${url}/v1`) },
  'openai-compatible': { family: 'openai', model: 'gpt-test', make: (url) => createOpenAIProvider('k', `${url}/v1`) },
  'azure-openai': {
    family: 'openai',
    model: 'gpt-test',
    make: (url) => createAzureOpenAIProvider({ apiKey: 'k', baseUrl: `${url}/openai` })
  },
  gemini: {
    family: 'gemini',
    model: 'gemini-2.5-flash',
    make: (url) => {
      vi.stubEnv('GOOGLE_GEMINI_BASE_URL', url)
      return createGeminiProvider('k')
    }
  }
}

/** Run one turn and return what it threw. The signal bounds an SDK that sleeps out a long wait. */
async function failureOf(provider: Provider, model: string): Promise<unknown> {
  try {
    const gen = provider.streamChat({
      model,
      messages: [{ role: 'user', content: 'hi' }],
      signal: AbortSignal.timeout(2_000)
    })
    while (!(await gen.next()).done) {
      /* drain */
    }
  } catch (e) {
    return e
  }
  throw new Error('the turn finished without an error')
}

let server: StubServer | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('provider chat clients leave retrying to Houston', () => {
  it.each(Object.entries(ADAPTERS))(
    '%s: a 429 with retry-after: 3600 fails after one request, with the wait clamped',
    async (_kind, a) => {
      server = await answerEvery(429, { 'retry-after': '3600' }, ERROR_BODIES[a.family].rateLimited)
      const err = await failureOf(a.make(server.url), a.model)
      expect(server.requests()).toBe(1)
      expect(isRetryableError(err)).toBe(true)
      expect(retryAfterHintMs(err)).toBe(60_000)
    }
  )

  it.each(Object.entries(ADAPTERS))('%s: a 503 fails after one request, as retryable', async (_kind, a) => {
    server = await answerEvery(503, {}, ERROR_BODIES[a.family].overloaded)
    const err = await failureOf(a.make(server.url), a.model)
    expect(server.requests()).toBe(1)
    expect(isRetryableError(err)).toBe(true)
  })
})

describe('Gemini quota errors, as the real SDK throws them', () => {
  it('a per-minute quota is retryable after the delay Gemini names', async () => {
    server = await answerEvery(
      429,
      {},
      geminiQuotaBody({ quotaId: GEMINI_PER_MINUTE_QUOTA_ID, retryDelay: '41s', retryText: 'Please retry in 41.18s.' })
    )
    const err = await failureOf(ADAPTERS.gemini.make(server.url), 'gemini-2.5-flash')
    expect(isQuotaExhaustedError(err)).toBe(false)
    expect(isRetryableError(err)).toBe(true)
    expect(retryAfterHintMs(err)).toBe(41_000)
  })

  it('a per-day quota is exhausted', async () => {
    server = await answerEvery(429, {}, geminiQuotaBody({ quotaId: GEMINI_PER_DAY_QUOTA_ID, retryDelay: '13s' }))
    const err = await failureOf(ADAPTERS.gemini.make(server.url), 'gemini-2.5-flash')
    expect(isQuotaExhaustedError(err)).toBe(true)
    expect(isRetryableError(err)).toBe(false)
  })
})

describe('model listing', () => {
  /** The listing deadline: Fetch models / Test key give up after this long. */
  const DEADLINE_MS = 15_000

  it.each([
    ['anthropic', (url: string) => listAnthropicModels('k', url)],
    ['openai', (url: string) => listOpenAIModels('k', `${url}/v1`)]
  ] as const)('%s: a 503 fails after one request', async (_name, list) => {
    server = await answerEvery(503, {}, ERROR_BODIES.openai.overloaded)
    await expect(list(server.url)).rejects.toThrow()
    expect(server.requests()).toBe(1)
  })

  it.each([
    ['anthropic', () => listAnthropicModels('k', 'http://127.0.0.1:9')],
    ['openai', () => listOpenAIModels('k', 'http://127.0.0.1:9/v1')],
    ['gemini', () => listGeminiModels('k')]
  ] as const)('%s: a network that never answers fails at the deadline', async (_name, list) => {
    // What a network that drops packets looks like to fetch: no response, ever, until
    // the request's own signal gives up on it.
    let called!: () => void
    const reached = new Promise<void>((resolve) => (called = resolve))
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            called()
            init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
          })
      )
    )
    vi.useFakeTimers()
    let outcome: 'pending' | 'resolved' | Error = 'pending'
    const settled = list().then(
      () => (outcome = 'resolved'),
      (e: Error) => (outcome = e)
    )
    await reached
    await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1)
    expect(outcome).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    await settled
    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as unknown as Error).message).toMatch(/timed out/i)
  })
})
