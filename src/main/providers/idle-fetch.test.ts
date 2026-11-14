import { afterEach, describe, expect, it, vi } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import type { Provider, ProviderStreamEvent } from '@shared/agent'
import {
  EXTENDED_STREAM_IDLE_TIMEOUT_MS,
  idleTimeoutFetch,
  isLocalModelHost,
  requestedStreamIdleWindow,
  STREAM_IDLE_TIMEOUT_MS,
  streamIdleTimeoutFor,
  streamIdleWindowOf,
  StreamIdleError,
  STREAM_IDLE_CODE,
  withStreamIdleWindow
} from './idle-fetch'
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
    // Fake timers: a wall-clock sleep overshoots the window on a loaded runner.
    vi.useFakeTimers()
    try {
      const text = readAll(res)
      // Each gap is under the window; together they're well past it.
      for (const part of ['a', 'b', 'c', 'd']) {
        m.push(part)
        await vi.advanceTimersByTimeAsync(90)
      }
      m.end()
      expect(await text).toBe('abcd')
    } finally {
      vi.useRealTimers()
    }
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
  it('stretches the window for a request sent inside withStreamIdleWindow', async () => {
    const m = manualFetch()
    vi.useFakeTimers()
    try {
      const res = await withStreamIdleWindow(500, () => idleTimeoutFetch(50, m.fetch)('http://x'))
      const text = readAll(res)
      // Well past the fetch's own 50ms, inside the requested 500ms.
      await vi.advanceTimersByTimeAsync(400)
      m.push('late')
      m.end()
      expect(await text).toBe('late')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports the stretched window on the stall, and never shortens the fetch window', async () => {
    const long = manualFetch()
    const res = await withStreamIdleWindow(80, () => idleTimeoutFetch(20, long.fetch)('http://x'))
    const err = await readAll(res).catch((e: unknown) => e)
    expect((err as StreamIdleError).idleMs).toBe(80)

    const short = manualFetch()
    const res2 = await withStreamIdleWindow(5, () => idleTimeoutFetch(40, short.fetch)('http://x'))
    const err2 = await readAll(res2).catch((e: unknown) => e)
    expect((err2 as StreamIdleError).idleMs).toBe(40)
  })

  it('scopes the requested window to the call it wraps', async () => {
    expect(requestedStreamIdleWindow()).toBeUndefined()
    await withStreamIdleWindow(123, async () => {
      await sleep(1)
      expect(requestedStreamIdleWindow()).toBe(123)
    })
    expect(requestedStreamIdleWindow()).toBeUndefined()
  })

  it('keeps the longer window when calls nest', () => {
    withStreamIdleWindow(300, () => {
      withStreamIdleWindow(0, () => expect(requestedStreamIdleWindow()).toBe(300))
      withStreamIdleWindow(900, () => expect(requestedStreamIdleWindow()).toBe(900))
    })
  })
})

describe('streamIdleWindowOf', () => {
  it('reads the window off an idle stall, directly or wrapped by an SDK', () => {
    expect(streamIdleWindowOf(new StreamIdleError(600_000))).toBe(600_000)
    expect(streamIdleWindowOf(new Error('Connection error.', { cause: new StreamIdleError(7) }))).toBe(7)
    // A bare code (no window recorded) reads as the default window.
    expect(streamIdleWindowOf(Object.assign(new Error('x'), { code: STREAM_IDLE_CODE }))).toBe(STREAM_IDLE_TIMEOUT_MS)
  })

  it('is undefined for any other failure', () => {
    expect(streamIdleWindowOf(new Error('Connection error.'))).toBeUndefined()
    expect(streamIdleWindowOf(undefined)).toBeUndefined()
    const cyclic: { cause?: unknown } = {}
    cyclic.cause = cyclic
    expect(streamIdleWindowOf(cyclic)).toBeUndefined()
  })
})

describe('per-host idle window', () => {
  it('treats the user’s own machine and private network as local', () => {
    for (const url of [
      'http://localhost:11434/v1',
      'http://LOCALHOST:1234/v1',
      'http://ollama.localhost/v1',
      'http://127.0.0.1:8000/v1',
      'http://127.1.2.3/v1',
      'http://[::1]:8080/v1',
      'http://0.0.0.0:8000/v1',
      'http://10.0.0.5:11434/v1',
      'http://192.168.1.20:1234/v1',
      'http://172.16.0.1/v1',
      'http://172.31.255.255/v1',
      'http://gpu-box.local:8000/v1',
      'http://[fd12:3456::1]/v1'
    ]) {
      expect(isLocalModelHost(url), url).toBe(true)
      expect(streamIdleTimeoutFor(url), url).toBe(EXTENDED_STREAM_IDLE_TIMEOUT_MS)
    }
  })

  it('keeps the default window for hosted endpoints and anything unparseable', () => {
    for (const url of [
      'https://openrouter.ai/api/v1',
      'https://api.openai.com/v1',
      'http://172.32.0.1/v1',
      'http://11.0.0.1/v1',
      'https://localhost.example.com/v1',
      'not a url',
      undefined
    ]) {
      expect(isLocalModelHost(url), String(url)).toBe(false)
      expect(streamIdleTimeoutFor(url), String(url)).toBe(STREAM_IDLE_TIMEOUT_MS)
    }
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

  it.each(providers)('%s: a window requested around the call reaches the real SDK fetch', async (_name, api, make) => {
    const s = await start(api, ['stall'])
    const r = await withStreamIdleWindow(300, () => drive(make(s.url, 50)))
    expect(r.text).toBe('the')
    // The stall was timed on the requested window, not the client's own 50ms.
    expect(streamIdleWindowOf(r.error)).toBe(300)
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
