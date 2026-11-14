import { afterEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { McpClient, type SpawnFn } from './client'
import { McpHttpClient, type FetchFn } from './http-client'
import { activeTraceContext, setTraceContextProvider, withTraceContext } from './trace'

const TP = '00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01'

afterEach(() => setTraceContextProvider(null))

describe('trace context seam', () => {
  it('adds nothing while there is no tracer (the same params object comes back)', () => {
    const params = { name: 'x' }
    expect(activeTraceContext()).toBeUndefined()
    expect(withTraceContext(params)).toBe(params)
  })

  it('puts the active span into _meta, keeping what _meta holds', () => {
    setTraceContextProvider(() => ({ traceparent: TP, tracestate: 'congo=t61rcWkgMzE', baggage: 'userId=alice' }))
    expect(withTraceContext({ name: 'x', _meta: { progressToken: 3 } })).toEqual({
      name: 'x',
      _meta: { progressToken: 3, traceparent: TP, tracestate: 'congo=t61rcWkgMzE', baggage: 'userId=alice' }
    })
  })

  it('sends nothing for a malformed traceparent, and drops unsafe tracestate or baggage', () => {
    for (const traceparent of [
      'nope',
      '00-00000000000000000000000000000000-00f067aa0ba902b7-01',
      '00-0af7651916cd43dd8448eb211c80319c-0000000000000000-01',
      'ff-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01',
      TP.toUpperCase()
    ]) {
      setTraceContextProvider(() => ({ traceparent }))
      expect(activeTraceContext()).toBeUndefined()
    }
    setTraceContextProvider(() => ({ traceparent: TP, tracestate: 'a=b\r\nInjected: 1', baggage: 'x'.repeat(9000) }))
    expect(activeTraceContext()).toEqual({ traceparent: TP })
  })

  it('never fails a request when the tracer throws', () => {
    setTraceContextProvider(() => {
      throw new Error('tracer down')
    })
    expect(withTraceContext({ a: 1 })).toEqual({ a: 1 })
  })
})

describe('MCP requests carry the trace context', () => {
  it('over stdio', async () => {
    setTraceContextProvider(() => ({ traceparent: TP }))
    const written: Array<{ method?: string; params?: { _meta?: Record<string, unknown> } }> = []
    const stdout = new EventEmitter()
    const stdin = Object.assign(new EventEmitter(), {
      write(line: string): boolean {
        const msg = JSON.parse(line.trim()) as { id?: number; method: string; params?: { _meta?: Record<string, unknown> } }
        written.push(msg)
        if (msg.id === undefined) return true
        const result = msg.method === 'tools/list' ? { tools: [{ name: 'echo' }] } : { content: [] }
        queueMicrotask(() => stdout.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`)))
        return true
      }
    })
    const child = Object.assign(new EventEmitter(), { stdout, stdin, stderr: new EventEmitter(), kill: () => {} })
    const client = new McpClient((() => child) as unknown as SpawnFn)
    await client.connect({ command: 'fake' })
    await client.callTool('echo', {})
    const call = written.find((m) => m.method === 'tools/call')!
    expect(call.params?._meta).toMatchObject({ traceparent: TP, progressToken: expect.anything() })
    client.close()
  })

  it('over streamable HTTP', async () => {
    setTraceContextProvider(() => ({ traceparent: TP }))
    const bodies: Array<{ method?: string; params?: { _meta?: Record<string, unknown> } }> = []
    const fetch: FetchFn = async (_u, init) => {
      if (init.method === 'GET') return new Response('', { status: 405 })
      const msg = JSON.parse(init.body as string) as { id?: number; method?: string; params?: { _meta?: Record<string, unknown> } }
      bodies.push(msg)
      if (msg.id === undefined) return new Response('', { status: 202 })
      const result = msg.method === 'tools/list' ? { tools: [{ name: 'echo' }] } : { content: [] }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }), {
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' })
      })
    }
    const client = new McpHttpClient(fetch)
    await client.connect({ url: 'https://x.test/mcp' })
    await client.callTool('echo', {})
    expect(bodies.find((m) => m.method === 'tools/call')?.params?._meta).toMatchObject({ traceparent: TP })
    client.close()
  })
})
