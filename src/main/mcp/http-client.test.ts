import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { version as PKG_VERSION } from '../../../package.json'
import { McpHttpClient, extractSseData, pickJsonRpc, type FetchFn } from './http-client'
import { LATEST_PROTOCOL_VERSION, McpUnsupportedProtocolError } from './version'

describe('extractSseData', () => {
  it('pulls data payloads out of an SSE body', () => {
    const body = 'event: message\ndata: {"a":1}\n\ndata: {"b":2}\n\n'
    expect(extractSseData(body)).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('joins multi-line data within one event', () => {
    const body = 'data: line1\ndata: line2\n\n'
    expect(extractSseData(body)).toEqual(['line1\nline2'])
  })
})

describe('pickJsonRpc', () => {
  it('reads a plain JSON body', () => {
    expect(pickJsonRpc('application/json', '{"id":1,"result":{"ok":true}}', 1)).toEqual({
      id: 1,
      result: { ok: true }
    })
  })

  it('reads the matching id from an SSE body with several messages', () => {
    const body = 'data: {"id":1,"result":"a"}\n\ndata: {"id":2,"result":"b"}\n\n'
    expect(pickJsonRpc('text/event-stream', body, 2)).toEqual({ id: 2, result: 'b' })
  })

  it('returns null when nothing parseable matches', () => {
    expect(pickJsonRpc('application/json', 'not json', 1)).toBeNull()
  })
})

/** Build a fake fetch that answers MCP JSON-RPC over HTTP. */
function fakeServer(
  opts: { sse?: boolean; sessionId?: string; tool?: string; resources?: boolean } = {}
): {
  fetch: FetchFn
  calls: Array<{ method: string; headers: Record<string, string> }>
} {
  const calls: Array<{ method: string; headers: Record<string, string> }> = []
  const fetch: FetchFn = async (_url, init) => {
    const req = JSON.parse(init.body as string) as { id?: number; method: string }
    const headers = init.headers as Record<string, string>
    calls.push({ method: req.method, headers })
    const reply = (result: unknown): string => JSON.stringify({ jsonrpc: '2.0', id: req.id, result })
    let result: unknown = {}
    if (req.method === 'initialize') result = opts.resources ? { capabilities: { resources: {} } } : {}
    else if (req.method === 'tools/list') result = { tools: [{ name: opts.tool ?? 'echo' }] }
    else if (req.method === 'tools/call') result = { content: [{ type: 'text', text: 'hi there' }] }
    else if (req.method === 'resources/list')
      result = {
        resources: [
          { uri: 'file:///a.txt', name: 'A', description: 'The A file', mimeType: 'text/plain' }
        ]
      }
    else if (req.method === 'resources/read')
      result = { contents: [{ uri: 'file:///a.txt', mimeType: 'text/plain', text: 'file contents' }] }
    const respHeaders = new Headers({
      'content-type': opts.sse ? 'text/event-stream' : 'application/json',
      ...(opts.sessionId && req.method === 'initialize' ? { 'mcp-session-id': opts.sessionId } : {})
    })
    const bodyText =
      req.id === undefined ? '' : opts.sse ? `data: ${reply(result)}\n\n` : reply(result)
    return new Response(bodyText, { status: 200, headers: respHeaders })
  }
  return { fetch, calls }
}

describe('McpHttpClient', () => {
  it('initializes, lists tools, and calls a tool (JSON transport)', async () => {
    const { fetch } = fakeServer({ tool: 'search' })
    const client = new McpHttpClient(fetch)
    await client.connect({ url: 'https://x/mcp' })
    expect(client.tools.map((t) => t.name)).toEqual(['search'])
    expect(await client.callTool('search', { q: 'hi' })).toBe('hi there')
  })

  it('works over an SSE response body', async () => {
    const { fetch } = fakeServer({ sse: true })
    const client = new McpHttpClient(fetch)
    await client.connect({ url: 'https://x/mcp' })
    expect(await client.callTool('echo', {})).toBe('hi there')
  })

  it('captures and echoes the session id, and sends custom headers', async () => {
    const { fetch, calls } = fakeServer({ sessionId: 'sess-123' })
    const client = new McpHttpClient(fetch)
    await client.connect({ url: 'https://x/mcp', headers: { authorization: 'Bearer t' } })
    await client.callTool('echo', {})
    const toolCall = calls.find((c) => c.method === 'tools/call')!
    expect(toolCall.headers['mcp-session-id']).toBe('sess-123')
    expect(toolCall.headers['authorization']).toBe('Bearer t')
  })

  it('lists and reads resources when the server declares the capability', async () => {
    const { fetch, calls } = fakeServer({ resources: true })
    const client = new McpHttpClient(fetch)
    await client.connect({ url: 'https://x/mcp' })
    expect(client.resources.map((r) => r.uri)).toEqual(['file:///a.txt'])
    expect(client.resources[0]).toMatchObject({ name: 'A', mimeType: 'text/plain' })
    expect(await client.readResource('file:///a.txt')).toBe('file contents')
    expect(calls.some((c) => c.method === 'resources/list')).toBe(true)
  })

  it('does not request resources when the capability is absent', async () => {
    const { fetch, calls } = fakeServer() // no resources capability declared
    const client = new McpHttpClient(fetch)
    await client.connect({ url: 'https://x/mcp' })
    expect(client.resources).toEqual([])
    expect(calls.some((c) => c.method === 'resources/list')).toBe(false)
  })

  it('rejects after close', async () => {
    const { fetch } = fakeServer()
    const client = new McpHttpClient(fetch)
    await client.connect({ url: 'https://x/mcp' })
    client.close()
    expect(client.isClosed).toBe(true)
    await expect(client.callTool('echo', {})).rejects.toThrow(/closed/)
  })

  it('throws on a JSON-RPC error response', async () => {
    const fetch: FetchFn = async (_u, init) => {
      const req = JSON.parse(init.body as string) as { id: number }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { message: 'nope' } }), {
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' })
      })
    }
    const client = new McpHttpClient(fetch)
    await expect(client.connect({ url: 'https://x/mcp' })).rejects.toThrow(/nope/)
  })

  const sse = (events: unknown[]): Response =>
    new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), {
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' })
    })

  it('acts on notifications interleaved in an SSE response body', async () => {
    let toolset = [{ name: 'one' }]
    const fetch: FetchFn = async (_u, init) => {
      if (init.method === 'GET') return new Response('', { status: 405 })
      const req = JSON.parse(init.body as string) as { id?: number; method: string }
      if (req.id === undefined) return new Response('', { status: 202 })
      if (req.method === 'tools/list')
        return sse([{ jsonrpc: '2.0', id: req.id, result: { tools: toolset } }])
      if (req.method === 'tools/call') {
        toolset = [{ name: 'one' }, { name: 'two' }]
        // The call's own stream carries a list_changed before the response.
        return sse([
          { jsonrpc: '2.0', method: 'notifications/tools/list_changed' },
          { jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: 'ok' }] } }
        ])
      }
      return sse([{ jsonrpc: '2.0', id: req.id, result: {} }])
    }
    const client = new McpHttpClient(fetch)
    await client.connect({ url: 'https://x/mcp' })
    expect(client.tools.map((t) => t.name)).toEqual(['one'])
    expect(await client.callTool('one', {})).toBe('ok')
    await new Promise((r) => setTimeout(r, 10))
    expect(client.tools.map((t) => t.name)).toEqual(['one', 'two'])
    client.close()
  })

  it('replies to a server request embedded in a response stream via its own POST', async () => {
    const posts: Array<Record<string, unknown>> = []
    const fetch: FetchFn = async (_u, init) => {
      if (init.method === 'GET') return new Response('', { status: 405 })
      const req = JSON.parse(init.body as string) as { id?: number; method?: string }
      posts.push(req as Record<string, unknown>)
      if (req.id === undefined || req.method === undefined) return new Response('', { status: 202 })
      if (req.method === 'tools/list')
        return sse([
          { jsonrpc: '2.0', id: 'srv-ping', method: 'ping' },
          { jsonrpc: '2.0', id: req.id, result: { tools: [] } }
        ])
      return sse([{ jsonrpc: '2.0', id: req.id, result: {} }])
    }
    const client = new McpHttpClient(fetch)
    await client.connect({ url: 'https://x/mcp' })
    await new Promise((r) => setTimeout(r, 10))
    expect(posts.some((p) => p.id === 'srv-ping' && 'result' in p)).toBe(true)
    client.close()
  })

  it('receives server notifications over the standing GET stream', async () => {
    let toolset = [{ name: 'one' }]
    let emitOnStream!: (e: unknown) => void
    const fetch: FetchFn = async (_u, init) => {
      if (init.method === 'GET') {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            emitOnStream = (e) =>
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`))
          }
        })
        return new Response(stream, {
          status: 200,
          headers: new Headers({ 'content-type': 'text/event-stream' })
        })
      }
      const req = JSON.parse(init.body as string) as { id?: number; method: string }
      if (req.id === undefined) return new Response('', { status: 202 })
      const result = req.method === 'tools/list' ? { tools: toolset } : {}
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }), {
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' })
      })
    }
    const client = new McpHttpClient(fetch)
    await client.connect({ url: 'https://x/mcp' })
    await new Promise((r) => setTimeout(r, 10)) // let the GET stream open
    toolset = [{ name: 'one' }, { name: 'two' }]
    emitOnStream({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
    await new Promise((r) => setTimeout(r, 10))
    expect(client.tools.map((t) => t.name)).toEqual(['one', 'two'])
    client.close()
  })

  describe('a dropped notification stream', () => {
    /** A server whose GET streams can be ended from the test; counts the GETs. */
    function droppingServer(getStatus: () => number = () => 200) {
      const state = {
        toolset: [{ name: 'one' }],
        gets: 0,
        streams: [] as Array<{ emit: (e: unknown) => void; end: () => void }>
      }
      const fetch: FetchFn = async (_u, init) => {
        if (init.method === 'GET') {
          state.gets++
          const status = getStatus()
          if (status !== 200) return new Response('', { status })
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              state.streams.push({
                emit: (e) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`)),
                end: () => controller.close()
              })
            }
          })
          return new Response(stream, { status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }) })
        }
        const req = JSON.parse(init.body as string) as { id?: number; method: string }
        if (req.id === undefined) return new Response('', { status: 202 })
        const result = req.method === 'tools/list' ? { tools: state.toolset } : {}
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }), {
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' })
        })
      }
      return { fetch, state }
    }
    const names = (c: McpHttpClient): string[] => c.tools.map((t) => t.name)

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('is reopened, and catches up on a change announced while it was down', async () => {
      const srv = droppingServer()
      const client = new McpHttpClient(srv.fetch)
      await client.connect({ url: 'https://x/mcp' })
      await vi.advanceTimersByTimeAsync(0)
      expect(srv.state.gets).toBe(1)

      srv.state.streams[0].end() // a proxy idle timeout, say
      srv.state.toolset = [{ name: 'one' }, { name: 'two' }] // changed while nobody listened
      await vi.advanceTimersByTimeAsync(1_000)
      expect(srv.state.gets).toBe(2)
      await vi.advanceTimersByTimeAsync(0)
      expect(names(client)).toEqual(['one', 'two'])

      // Notifications flow on the reopened stream.
      srv.state.toolset = [{ name: 'three' }]
      srv.state.streams[1].emit({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
      await vi.advanceTimersByTimeAsync(0)
      expect(names(client)).toEqual(['three'])
      client.close()
    })

    it('backs off while the server keeps failing, and stops once closed', async () => {
      let status = 200
      const srv = droppingServer(() => status)
      const client = new McpHttpClient(srv.fetch)
      await client.connect({ url: 'https://x/mcp' })
      await vi.advanceTimersByTimeAsync(0)
      status = 503
      srv.state.streams[0].end()
      await vi.advanceTimersByTimeAsync(1_000) // 1st retry after 1 s
      expect(srv.state.gets).toBe(2)
      await vi.advanceTimersByTimeAsync(1_999) // 2nd waits 2 s
      expect(srv.state.gets).toBe(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(srv.state.gets).toBe(3)
      client.close()
      await vi.advanceTimersByTimeAsync(120_000)
      expect(srv.state.gets).toBe(3)
    })

    it('is not retried when the server offers no stream (405)', async () => {
      const srv = droppingServer(() => 405)
      const client = new McpHttpClient(srv.fetch)
      await client.connect({ url: 'https://x/mcp' })
      await vi.advanceTimersByTimeAsync(120_000)
      expect(srv.state.gets).toBe(1)
      client.close()
    })
  })

  it('marks itself closed when the server expires the session (404)', async () => {
    const fetch: FetchFn = async (_u, init) => {
      if (init.method === 'GET') return new Response('', { status: 405 })
      const req = JSON.parse(init.body as string) as { id?: number; method: string }
      if (req.id === undefined) return new Response('', { status: 202 })
      if (req.method === 'tools/call') return new Response('', { status: 404 })
      const result = req.method === 'tools/list' ? { tools: [{ name: 'echo' }] } : {}
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }), {
        status: 200,
        headers: new Headers({
          'content-type': 'application/json',
          ...(req.method === 'initialize' ? { 'mcp-session-id': 'sess-1' } : {})
        })
      })
    }
    const client = new McpHttpClient(fetch)
    await client.connect({ url: 'https://x/mcp' })
    await expect(client.callTool('echo', {})).rejects.toThrow(/session/)
    expect(client.isClosed).toBe(true)
  })

  it('throws the typed unauthorized error on a 401', async () => {
    const fetch: FetchFn = async () =>
      new Response('', { status: 401, headers: new Headers({ 'www-authenticate': 'Bearer realm="mcp"' }) })
    const client = new McpHttpClient(fetch)
    await expect(client.connect({ url: 'https://x/mcp' })).rejects.toThrow(/401/)
  })
})

describe('McpHttpClient protocol-version negotiation', () => {
  interface Post {
    body: Record<string, unknown>
    headers: Record<string, string>
  }
  /**
   * A server that answers initialize with `initResult` and, on tools/list,
   * streams an `elicitation/create` request ahead of the list result.
   */
  function negotiatingFetch(initResult: unknown, posts: Post[], gets: Array<Record<string, string>>): FetchFn {
    return async (_u, init) => {
      const headers = init.headers as Record<string, string>
      if (init.method === 'GET') {
        gets.push(headers)
        return new Response('', { status: 405 })
      }
      const body = JSON.parse(init.body as string) as Record<string, unknown> & { id?: number; method?: string }
      posts.push({ body, headers })
      if (body.id === undefined || body.method === undefined) return new Response('', { status: 202 })
      const json = (msgs: unknown[]): Response =>
        new Response(msgs.map((m) => `data: ${JSON.stringify(m)}\n\n`).join(''), {
          status: 200,
          headers: new Headers({ 'content-type': 'text/event-stream' })
        })
      if (body.method === 'initialize') return json([{ jsonrpc: '2.0', id: body.id, result: initResult }])
      if (body.method === 'tools/list')
        return json([
          { jsonrpc: '2.0', id: 'el1', method: 'elicitation/create', params: {} },
          { jsonrpc: '2.0', id: body.id, result: { tools: [] } }
        ])
      return json([{ jsonrpc: '2.0', id: body.id, result: {} }])
    }
  }
  const onElicit = async (): Promise<{ action: 'accept'; content: Record<string, unknown> }> => ({
    action: 'accept',
    content: { ok: true }
  })
  const replyTo = (posts: Post[], id: string): Record<string, unknown> | undefined =>
    posts.find((p) => p.body.id === id && p.body.method === undefined)?.body

  it('requests the latest version, then sends the negotiated one in the header', async () => {
    const posts: Post[] = []
    const gets: Array<Record<string, string>> = []
    const client = new McpHttpClient(negotiatingFetch({ protocolVersion: '2025-03-26' }, posts, gets))
    await client.connect({ url: 'https://x/mcp' })
    await new Promise((r) => setTimeout(r, 10))
    const [init, ...rest] = posts
    expect(init.body.params).toMatchObject({
      protocolVersion: LATEST_PROTOCOL_VERSION,
      clientInfo: { name: 'Houston', version: PKG_VERSION }
    })
    // Nothing is agreed before initialize answers, so that POST goes without it.
    expect(init.headers['mcp-protocol-version']).toBeUndefined()
    expect(rest.length).toBeGreaterThan(0)
    for (const p of rest) expect(p.headers['mcp-protocol-version']).toBe('2025-03-26')
    expect(gets[0]?.['mcp-protocol-version']).toBe('2025-03-26')
    client.close()
  })

  it('answers elicitation from a 2025-06-18 server', async () => {
    const posts: Post[] = []
    const client = new McpHttpClient(negotiatingFetch({ protocolVersion: '2025-06-18' }, posts, []))
    await client.connect({ url: 'https://x/mcp', onElicit })
    await new Promise((r) => setTimeout(r, 10))
    expect((posts[0].body.params as { capabilities: unknown }).capabilities).toEqual({ elicitation: {} })
    expect(replyTo(posts, 'el1')?.result).toEqual({ action: 'accept', content: { ok: true } })
    expect(posts.at(-1)?.headers['mcp-protocol-version']).toBe('2025-06-18')
    client.close()
  })

  it('declines elicitation from a server that negotiated 2024-11-05', async () => {
    const posts: Post[] = []
    const client = new McpHttpClient(negotiatingFetch({ protocolVersion: '2024-11-05' }, posts, []))
    await client.connect({ url: 'https://x/mcp', onElicit })
    await new Promise((r) => setTimeout(r, 10))
    expect((replyTo(posts, 'el1')?.error as { code: number }).code).toBe(-32601)
    client.close()
  })

  it('fails the connection on an unsupported version, before initialized is sent', async () => {
    const posts: Post[] = []
    const client = new McpHttpClient(negotiatingFetch({ protocolVersion: '2099-01-01' }, posts, []))
    await expect(client.connect({ url: 'https://x/mcp' })).rejects.toThrow(McpUnsupportedProtocolError)
    expect(posts.map((p) => p.body.method)).toEqual(['initialize'])
  })
})
