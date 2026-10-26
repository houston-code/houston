import { afterEach, describe, expect, it } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import type { Provider, ProviderStreamEvent } from '@shared/agent'
import { idleTimeoutFetch, StreamIdleError, STREAM_IDLE_CODE } from './idle-fetch'
import { createMessagesProvider } from './anthropic'
import { createChatCompletionsProvider } from './openai'
import { isRetryableError } from '../agent/retry'
import { startFlakySseServer, type FlakySseServer, type Hiccup } from '../test/flaky-sse-server'

const enc = new TextEncoder()
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** A base fetch whose body is driven by hand: `push` a chunk, `end` it, or neither (a stall). */
function manualFetch(init: ResponseInit = { status: 200 }): {
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  push: (s: string) => void
  end: () => void
  cancelled: () => unknown
} {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>
  let cancelReason: unknown
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c
    },
    cancel(reason) {
      cancelReason = reason
    }
  })
  return {
    fetch: async () => new Response(body, init),
    push: (s) => ctrl.enqueue(enc.encode(s)),
    end: () => ctrl.close(),
    cancelled: () => cancelReason
  }
}

async function readAll(res: Response): Promise<string> {
  return await res.text()
}

describe('idleTimeoutFetch', () => {
  it('passes a body that keeps talking through unchanged, with its status and headers', async () => {
    const m = manualFetch({ status: 201, statusText: 'Made', headers: { 'x-a': '1' } })
    const res = await idleTimeoutFetch(100, m.fetch)('http://x')
    expect(res.status).toBe(201)
    expect(res.statusText).toBe('Made')
    expect(res.headers.get('x-a')).toBe('1')
    const text = readAll(res)
    // Each gap is under the window; together they're well past it.
    for (const part of ['a', 'b', 'c', 'd']) {
      m.push(part)
      await sleep(60)
    }
    m.end()
    expect(await text).toBe('abcd')
  })

  it('fails a body that goes quiet past the window, and releases the upstream body', async () => {
    const m = manualFetch()
    const res = await idleTimeoutFetch(50, m.fetch)('http://x')
    m.push('par')
    const err = await readAll(res).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(StreamIdleError)
    expect((err as StreamIdleError).code).toBe(STREAM_IDLE_CODE)
    expect((err as Error).message).toContain('no data for 0s')
    expect(isRetryableError(err)).toBe(true)
    expect(m.cancelled()).toBeInstanceOf(StreamIdleError)
  })

  it('does not count time the consumer spends not reading', async () => {
    const m = manualFetch()
    const res = await idleTimeoutFetch(50, m.fetch)('http://x')
    const reader = res.body!.getReader()
    m.push('one')
    m.push('two')
    m.end()
    await sleep(150)
    const parts: string[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(new TextDecoder().decode(value))
      await sleep(80)
    }
    expect(parts.join('')).toBe('onetwo')
  })

  it('forwards a cancel from the consumer upstream', async () => {
    const m = manualFetch()
    const res = await idleTimeoutFetch(10_000, m.fetch)('http://x')
    await res.body!.cancel('done with it')
    expect(m.cancelled()).toBe('done with it')
  })

  it('returns a bodiless response untouched', async () => {
    const res204 = new Response(null, { status: 204 })
    expect(await idleTimeoutFetch(50, async () => res204)('http://x')).toBe(res204)
  })
})

/**
 * The real SDK clients and adapters, over a real socket: the failures a network hiccup
 * produces have to come out of the provider classified as transient, or the loop's
 * retry never runs.
 */
describe('provider streams over a flaky connection', () => {
  let server: FlakySseServer | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  const providers: Array<[string, 'anthropic' | 'chat', (url: string, idleMs: number) => Provider]> = [
    [
      'Anthropic Messages',
      'anthropic',
      (url, idleMs) =>
        createMessagesProvider(async () => new Anthropic({ apiKey: 'k', baseURL: url, maxRetries: 0, fetch: idleTimeoutFetch(idleMs) }))
    ],
    [
      'Chat Completions',
      'chat',
      (url, idleMs) =>
        createChatCompletionsProvider(
          async () => new OpenAI({ apiKey: 'k', baseURL: `${url}/v1`, maxRetries: 0, fetch: idleTimeoutFetch(idleMs) })
        )
    ]
  ]

  async function drive(provider: Provider): Promise<{ text: string; error?: unknown }> {
    let text = ''
    try {
      for await (const ev of provider.streamChat({
        model: 'claude-test',
        messages: [{ role: 'user', content: 'hi' }],
        signal: new AbortController().signal
      }) as AsyncIterable<ProviderStreamEvent>) {
        if (ev.type === 'text') text += ev.text
      }
      return { text }
    } catch (error) {
      return { text, error }
    }
  }

  const start = async (api: 'anthropic' | 'chat', script: Hiccup[]): Promise<FlakySseServer> =>
    (server = await startFlakySseServer(api, script))

  it.each(providers)('%s: a connection dropped mid-stream fails as retryable', async (_name, api, make) => {
    const s = await start(api, ['reset'])
    const r = await drive(make(s.url, 10_000))
    expect(r.text).toBe('the')
    expect(r.error).toBeDefined()
    expect(isRetryableError(r.error)).toBe(true)
  })

  it.each(providers)('%s: a stream that goes silent fails as retryable once idle', async (_name, api, make) => {
    const s = await start(api, ['stall'])
    const t0 = Date.now()
    const r = await drive(make(s.url, 150))
    expect(Date.now() - t0).toBeLessThan(5_000)
    expect(r.text).toBe('the')
    expect(isRetryableError(r.error)).toBe(true)
  })

  it('ends a stalled body on a request abort as an abort, not an idle timeout', async () => {
    const s = await start('anthropic', ['stall'])
    const ac = new AbortController()
    const res = await idleTimeoutFetch(10_000)(`${s.url}/v1/messages`, { method: 'POST', body: '{}', signal: ac.signal })
    const reading = readAll(res).catch((e: unknown) => e)
    await sleep(20)
    ac.abort()
    const err = await reading
    expect((err as Error).name).toBe('AbortError')
    expect(err).not.toBeInstanceOf(StreamIdleError)
  })

  it.each(providers)('%s: a healthy stream completes through the wrapper', async (_name, api, make) => {
    const s = await start(api, ['ok'])
    const r = await drive(make(s.url, 150))
    expect(r.error).toBeUndefined()
    expect(r.text).toBe('the whole answer')
  })
})
