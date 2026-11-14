import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ChatRequest, Provider } from '@shared/agent'
import { createBedrockProvider } from './bedrock'
import { createVertexProvider } from './vertex'
import { classifyProviderFailure, isRetryableError } from '../agent/retry'
import { CREDENTIAL_LOOKUP_LIMIT_MS } from './cloud-credentials'

/**
 * The cloud hosts resolve credentials inside the SDK's request pipeline, before the
 * request's own timer starts and without looking at the run's abort signal: an AWS
 * credential_process that waits on a prompt, an SSO refresh, or a Google metadata
 * server that never answers held the turn forever, and Stop could not end it.
 *
 * These run the real SDK clients (only the credential source and the network are
 * stubbed), because the bug lives in how the SDK sequences signing and fetching.
 */

const h = vi.hoisted(() => ({
  /** What the stub credential source does when asked. */
  credentials: (): Promise<unknown> => new Promise(() => {}),
  fetch: vi.fn(),
  built: 0
}))

vi.mock('@anthropic-ai/bedrock-sdk', async (importOriginal) => {
  const real = await importOriginal<typeof import('@anthropic-ai/bedrock-sdk')>()
  class StubCredentialsMantle extends real.AnthropicBedrockMantle {
    constructor(opts: ConstructorParameters<typeof real.AnthropicBedrockMantle>[0]) {
      h.built++
      super({
        ...opts,
        awsRegion: 'us-east-1',
        providerChainResolver: async () => async () => (await h.credentials()) as never,
        fetch: h.fetch as never
      })
    }
  }
  return { ...real, AnthropicBedrockMantle: StubCredentialsMantle }
})

vi.mock('@anthropic-ai/vertex-sdk', async (importOriginal) => {
  const real = await importOriginal<typeof import('@anthropic-ai/vertex-sdk')>()
  class StubCredentialsVertex extends real.AnthropicVertex {
    constructor(opts: ConstructorParameters<typeof real.AnthropicVertex>[0]) {
      h.built++
      super({
        ...opts,
        region: 'us-east5',
        projectId: 'p',
        authClient: {
          projectId: 'p',
          getRequestHeaders: async () => {
            await h.credentials()
            return new Headers({ authorization: 'Bearer t' })
          }
        } as never,
        fetch: h.fetch as never
      })
    }
  }
  return { ...real, AnthropicVertex: StubCredentialsVertex }
})

/** A minimal, complete Messages SSE reply. */
function sseReply(): Response {
  const events = [
    ['message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }]
  ] as const
  const body = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

async function drain(provider: Provider, signal?: AbortSignal): Promise<string> {
  let text = ''
  for await (const ev of provider.streamChat({
    model: 'claude-opus-4-8',
    messages: [{ role: 'user', content: 'hi' }],
    ...(signal ? { signal } : {})
  } as ChatRequest)) {
    if (ev.type === 'text') text += ev.text
  }
  return text
}

/** Settles with the outcome, or 'still pending' if the promise hangs past `ms` of real time. */
async function within<T>(p: Promise<T>, ms: number): Promise<{ ok: T } | { err: unknown } | 'still pending'> {
  return Promise.race([
    p.then((ok) => ({ ok }), (err: unknown) => ({ err })),
    new Promise<'still pending'>((r) => setTimeout(() => r('still pending'), ms))
  ])
}

const hosts = [
  {
    name: 'Bedrock',
    make: () => createBedrockProvider({ region: 'us-east-1' }),
    fix: /aws sso login/
  },
  {
    name: 'Vertex',
    make: () => createVertexProvider({ region: 'us-east5', projectId: 'p' }),
    fix: /gcloud auth application-default login/
  }
]

describe.each(hosts)('$name credential lookup', ({ make, fix }) => {
  beforeEach(() => {
    h.fetch.mockReset()
    h.fetch.mockImplementation(async () => sseReply())
    h.credentials = () => new Promise(() => {})
    h.built = 0
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('ends promptly on Stop while the credential source never answers', async () => {
    const abort = new AbortController()
    const turn = drain(make(), abort.signal)
    setTimeout(() => abort.abort(), 20)
    const outcome = await within(turn, 2_000)
    expect(outcome).not.toBe('still pending')
    expect(outcome).toHaveProperty('err')
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it('fails with a plain, non-retried error once the lookup passes its limit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const turn = drain(make()).then(
      () => undefined,
      (e: unknown) => e
    )
    await vi.advanceTimersByTimeAsync(CREDENTIAL_LOOKUP_LIMIT_MS + 1_000)
    vi.useRealTimers()
    const err = await within(turn, 2_000)
    expect(err).not.toBe('still pending')
    const e = (err as { ok: unknown }).ok as Error
    expect(e).toBeInstanceOf(Error)
    expect(e.message).toMatch(fix)
    expect(e.message).toMatch(/30 seconds/)
    // Waiting again for the same stuck source only doubles the wait.
    expect(isRetryableError(e)).toBe(false)
    expect(classifyProviderFailure(e)).toBe('auth')
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it('still sends the request when credentials arrive in time', async () => {
    h.credentials = () =>
      new Promise((r) => setTimeout(() => r({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' }), 10))
    await expect(drain(make())).resolves.toBe('ok')
    expect(h.fetch).toHaveBeenCalledTimes(1)
  })

  it('recovers on the next turn after a stuck lookup', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const provider = make()
    const first = drain(provider).then(
      () => undefined,
      (e: unknown) => e
    )
    await vi.advanceTimersByTimeAsync(CREDENTIAL_LOOKUP_LIMIT_MS + 1_000)
    vi.useRealTimers()
    expect(await first).toBeInstanceOf(Error)
    h.credentials = async () => ({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' })
    await expect(drain(provider)).resolves.toBe('ok')
    // A fresh client, so a lookup the SDK cached (google-auth's client) is asked again.
    expect(h.built).toBe(2)
  })

  it('never sends the request when the credentials arrive after the turn failed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    h.credentials = () =>
      new Promise((r) =>
        setTimeout(() => r({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' }), CREDENTIAL_LOOKUP_LIMIT_MS + 5_000)
      )
    const turn = drain(make()).then(
      () => undefined,
      (e: unknown) => e
    )
    await vi.advanceTimersByTimeAsync(CREDENTIAL_LOOKUP_LIMIT_MS + 10_000)
    vi.useRealTimers()
    expect(await turn).toBeInstanceOf(Error)
    expect(h.fetch).not.toHaveBeenCalled()
  })
})
