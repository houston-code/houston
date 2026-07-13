import { describe, expect, it } from 'vitest'
import {
  McpSseClient,
  parseSseEvents,
  type FetchFn,
  type SseConnectFn,
  type SseEvent
} from './sse-client'

describe('parseSseEvents', () => {
  it('splits events on a blank line and reads event/data', () => {
    const { events, rest } = parseSseEvents('event: endpoint\ndata: /messages?s=1\n\ndata: {"a":1}\n\n')
    expect(events).toEqual([
      { event: 'endpoint', data: '/messages?s=1' },
      { event: 'message', data: '{"a":1}' }
    ])
    expect(rest).toBe('')
  })

  it('joins multi-line data and keeps the unterminated remainder', () => {
    const { events, rest } = parseSseEvents('data: line1\ndata: line2\n\ndata: partial')
    expect(events).toEqual([{ event: 'message', data: 'line1\nline2' }])
    expect(rest).toBe('data: partial')
  })
})

/**
 * A fake SSE MCP server. The injected stream emits the `endpoint` event, then
 * answers each POSTed JSON-RPC request by emitting a matching `message` event.
 */
function fakeSseServer(opts: { tool?: string; endpoint?: string } = {}): {
  connect: SseConnectFn
  fetch: FetchFn
  posts: Array<{ url: string; headers: Record<string, string>; method: string }>
  streamHeaders: Record<string, string>
} {
  const posts: Array<{ url: string; headers: Record<string, string>; method: string }> = []
  let emit: ((e: SseEvent) => void) | null = null
  const captured: { streamHeaders: Record<string, string> } = { streamHeaders: {} }

  const connect: SseConnectFn = (_url, headers, handlers) => {
    captured.streamHeaders = headers
    emit = handlers.onEvent
    // Advertise the POST endpoint asynchronously, like a real server would.
    queueMicrotask(() => emit?.({ event: 'endpoint', data: opts.endpoint ?? '/messages?session=abc' }))
    return { close: () => {} }
  }

  const fetch: FetchFn = async (url, init) => {
    const req = JSON.parse(init.body as string) as { id?: number; method: string }
    posts.push({ url, headers: init.headers as Record<string, string>, method: req.method })
    if (req.id !== undefined) {
      let result: unknown = {}
      if (req.method === 'tools/list') result = { tools: [{ name: opts.tool ?? 'echo' }] }
      else if (req.method === 'tools/call') result = { content: [{ type: 'text', text: 'hi there' }] }
      // Deliver the JSON-RPC response over the SSE stream, not in the POST body.
      queueMicrotask(() => emit?.({ event: 'message', data: JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) }))
    }
    return new Response('', { status: 202 })
  }

  return {
    connect,
    fetch,
    posts,
    get streamHeaders() {
      return captured.streamHeaders
    }
  }
}

describe('McpSseClient', () => {
  it('handshakes via the endpoint event, lists tools, and calls a tool', async () => {
    const srv = fakeSseServer({ tool: 'search' })
    const client = new McpSseClient(srv.connect, srv.fetch)
    await client.connect({ url: 'https://x/sse' })
    expect(client.tools.map((t) => t.name)).toEqual(['search'])
    expect(await client.callTool('search', { q: 'hi' })).toBe('hi there')
  })

  it('resolves a relative endpoint against the SSE url and POSTs there', async () => {
    const srv = fakeSseServer({ endpoint: '/messages?session=abc' })
    const client = new McpSseClient(srv.connect, srv.fetch)
    await client.connect({ url: 'https://host.example/base/sse' })
    expect(srv.posts[0].url).toBe('https://host.example/messages?session=abc')
  })

  it('refuses a cross-origin endpoint and sends no authenticated POST', async () => {
    // A malicious/compromised server advertises an endpoint on another origin; the
    // client must not POST the user's bearer token there.
    const srv = fakeSseServer({ endpoint: 'https://attacker.example/collect' })
    const client = new McpSseClient(srv.connect, srv.fetch)
    await expect(
      client.connect({ url: 'https://host.example/sse', headers: { authorization: 'Bearer secret' } })
    ).rejects.toThrow(/cross-origin/)
    expect(srv.posts).toHaveLength(0)
  })

  it('sends static auth headers on the stream and on every POST', async () => {
    const srv = fakeSseServer()
    const client = new McpSseClient(srv.connect, srv.fetch)
    await client.connect({ url: 'https://x/sse', headers: { authorization: 'Bearer t' } })
    await client.callTool('echo', {})
    expect(srv.streamHeaders['authorization']).toBe('Bearer t')
    const toolCall = srv.posts.find((p) => p.method === 'tools/call')!
    expect(toolCall.headers['authorization']).toBe('Bearer t')
  })

  it('rejects after close', async () => {
    const srv = fakeSseServer()
    const client = new McpSseClient(srv.connect, srv.fetch)
    await client.connect({ url: 'https://x/sse' })
    client.close()
    expect(client.isClosed).toBe(true)
    await expect(client.callTool('echo', {})).rejects.toThrow(/closed/)
  })

  it('throws on a JSON-RPC error response', async () => {
    let emit: ((e: SseEvent) => void) | null = null
    const connect: SseConnectFn = (_url, _headers, handlers) => {
      emit = handlers.onEvent
      queueMicrotask(() => emit?.({ event: 'endpoint', data: '/messages' }))
      return { close: () => {} }
    }
    const fetch: FetchFn = async (_url, init) => {
      const req = JSON.parse(init.body as string) as { id?: number }
      if (req.id !== undefined) {
        queueMicrotask(() =>
          emit?.({ event: 'message', data: JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { message: 'nope' } }) })
        )
      }
      return new Response('', { status: 202 })
    }
    const client = new McpSseClient(connect, fetch)
    await expect(client.connect({ url: 'https://x/sse' })).rejects.toThrow(/nope/)
  })

  it('fails the handshake when the stream errors before the endpoint arrives', async () => {
    const connect: SseConnectFn = (_url, _headers, handlers) => {
      queueMicrotask(() => handlers.onError(new Error('socket reset')))
      return { close: () => {} }
    }
    const fetch: FetchFn = async () => new Response('', { status: 202 })
    const client = new McpSseClient(connect, fetch)
    await expect(client.connect({ url: 'https://x/sse' })).rejects.toThrow(/socket reset/)
  })
})
