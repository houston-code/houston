import { describe, expect, it, vi } from 'vitest'
import { REGISTRY_CACHE_TTL_MS, createRegistryClient } from './mcpRegistry'
import { configureOutboundProxy } from './outbound-proxy'

// Every request goes to a mocked fetch: no test reaches the real registry.

const pageBody = {
  servers: [{ server: { name: 'io.github.acme/weather', description: 'Forecasts', version: '1.0.0' } }],
  metadata: { nextCursor: 'next-1' }
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

function client(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, now = () => 0) {
  const fetch = vi.fn(fetchImpl)
  return { fetch, c: createRegistryClient({ fetch: fetch as unknown as typeof globalThis.fetch, now, timeoutMs: 50, maxBytes: 4096 }) }
}

describe('createRegistryClient.search', () => {
  it('asks for the latest version of each match with the search words, and returns display data', async () => {
    const { fetch, c } = client(async () => jsonResponse(pageBody))
    const res = await c.search('  weather  ')
    expect(res).toEqual({
      ok: true,
      page: { servers: [{ name: 'io.github.acme/weather', description: 'Forecasts', version: '1.0.0', packages: [], remotes: [] }], nextCursor: 'next-1' }
    })
    const [url, init] = fetch.mock.calls[0]
    const u = new URL(url)
    expect(u.origin).toBe('https://registry.modelcontextprotocol.io')
    expect(u.pathname).toBe('/v0.1/servers')
    expect(Object.fromEntries(u.searchParams)).toEqual({ limit: '30', version: 'latest', search: 'weather' })
    expect(init?.method).toBe('GET')
    expect(init?.redirect).toBe('error')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('lists everything for an empty query, passes the cursor, and refuses one or two characters', async () => {
    const { fetch, c } = client(async () => jsonResponse(pageBody))
    await c.search('', 'abc:1.0')
    expect(Object.fromEntries(new URL(fetch.mock.calls[0][0]).searchParams)).toEqual({ limit: '30', version: 'latest', cursor: 'abc:1.0' })
    expect(await c.search('ab')).toEqual({ ok: false, error: 'Type at least 3 characters to search.' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('caches an answer briefly in memory', async () => {
    let t = 0
    const { fetch, c } = client(async () => jsonResponse(pageBody), () => t)
    await c.search('weather')
    await c.search('weather')
    expect(fetch).toHaveBeenCalledTimes(1)
    t = REGISTRY_CACHE_TTL_MS + 1
    await c.search('weather')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('does not cache failures', async () => {
    let n = 0
    const { fetch, c } = client(async () => (n++ === 0 ? new Response('busy', { status: 503 }) : jsonResponse(pageBody)))
    expect(await c.search('weather')).toEqual({ ok: false, error: 'The registry answered with an error (503).' })
    expect((await c.search('weather')).ok).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('refuses an answer over the size cap, declared or streamed', async () => {
    const big = 'x'.repeat(5000)
    const declared = client(async () => new Response(big, { headers: { 'content-length': '5000' } }))
    expect(await declared.c.search('weather')).toEqual({ ok: false, error: 'The registry’s answer was too large.' })
    const stream = new ReadableStream<Uint8Array>({
      start(ctl) {
        for (let i = 0; i < 10; i++) ctl.enqueue(new TextEncoder().encode('y'.repeat(1000)))
        ctl.close()
      }
    })
    const streamed = client(async () => new Response(stream))
    expect(await streamed.c.search('weather')).toEqual({ ok: false, error: 'The registry’s answer was too large.' })
  })

  it('reports a timeout, a network failure, and an unreadable answer', async () => {
    const slow = client(
      (_url, init) =>
        new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)))
    )
    expect(await slow.c.search('weather')).toEqual({ ok: false, error: 'The registry did not answer in time. Try again.' })
    const down = client(async () => {
      throw new TypeError('fetch failed')
    })
    expect((await down.c.search('weather')) as { error: string }).toMatchObject({ error: /Could not reach the MCP Registry/ })
    const garbage = client(async () => new Response('<html>'))
    expect(await garbage.c.search('weather')).toEqual({ ok: false, error: 'The registry sent an answer Houston could not read.' })
    const wrongShape = client(async () => jsonResponse({ servers: 'no' }))
    expect(await wrongShape.c.search('weather')).toEqual({ ok: false, error: 'The registry sent an answer Houston could not read.' })
  })
})

describe('createRegistryClient.get', () => {
  it('fetches the latest version by full name, encoding the slash', async () => {
    const { fetch, c } = client(async () => jsonResponse(pageBody.servers[0]))
    const res = await c.get('io.github.acme/weather')
    expect(res.ok && res.server.name).toBe('io.github.acme/weather')
    expect(fetch.mock.calls[0][0]).toBe('https://registry.modelcontextprotocol.io/v0.1/servers/io.github.acme%2Fweather/versions/latest')
  })

  it('reports an unknown name and refuses a malformed one without asking', async () => {
    const { fetch, c } = client(async () => new Response('{}', { status: 404 }))
    expect(await c.get('io.github.acme/none')).toEqual({ ok: false, error: 'The registry has no server with that name.' })
    expect((await c.get('two words')).ok).toBe(false)
    expect((await c.get('')).ok).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('createRegistryClient network path', () => {
  it('sends its requests through the outbound proxy when no fetch is injected', async () => {
    configureOutboundProxy(() => 'http://127.0.0.1:9')
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse(pageBody))
    try {
      expect((await createRegistryClient().search('weather')).ok).toBe(true)
      const init = spy.mock.calls[0][1] as RequestInit & { dispatcher?: unknown }
      expect(init.dispatcher).toBeDefined()
    } finally {
      spy.mockRestore()
      configureOutboundProxy(() => undefined)
    }
  })
})
