import { describe, expect, it } from 'vitest'
import { McpHttpClient, extractSseData, pickJsonRpc, type FetchFn } from './http-client'

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
})
