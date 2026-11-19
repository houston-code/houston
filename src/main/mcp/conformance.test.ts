import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { McpClient, type SpawnFn } from './client'
import { McpHttpClient, type FetchFn } from './http-client'

/**
 * A conformance-style matrix: the same scenarios against a fake server of each
 * protocol era Houston speaks, over stdio and streamable HTTP.
 *
 * - 2024-11-05, 2025-06-18, 2025-11-25: the `initialize` era. A discovery request is
 *   answered with an error (as an older server does), and the client must fall back.
 * - 2026-07-28: stateless. No `initialize`; every request must carry `_meta` (and the
 *   HTTP headers); elicitation comes back as `input_required`; change notifications
 *   arrive on `subscriptions/listen`.
 *
 * Scenarios: connect and list, a call, an elicitation answered through the client's
 * responder, Stop on a hung call, and a tools list change picked up.
 */

type Era = '2024-11-05' | '2025-06-18' | '2025-11-25' | '2026-07-28'
const ERAS: Era[] = ['2024-11-05', '2025-06-18', '2025-11-25', '2026-07-28']
const MODERN_META = 'io.modelcontextprotocol/protocolVersion'

interface Msg {
  jsonrpc?: string
  id?: number | string
  method?: string
  params?: Record<string, unknown> & { _meta?: Record<string, unknown> }
  result?: unknown
  error?: { code: number; message: string }
}

/** What a fake server of one era knows, shared by the two transports. */
class FakeServer {
  readonly seen: Msg[] = []
  readonly problems: string[] = []
  toolset = [{ name: 'echo' }, { name: 'ask' }, { name: 'slow' }]
  /** A legacy call waiting on the client's answer to the server's elicitation request. */
  waiting?: { callId: number | string; reply: (m: Msg) => void }

  constructor(readonly era: Era) {}

  get modern(): boolean {
    return this.era === '2026-07-28'
  }

  /** Answer one client message. `reply` sends a message back on the request's channel. */
  handle(msg: Msg, reply: (m: Msg) => void, headers?: Record<string, string>): void {
    this.seen.push(msg)
    if (msg.id === undefined || msg.method === undefined) {
      // A notification, or the client's reply to the server's own request.
      if (msg.id !== undefined && this.waiting && msg.id === 'el1') {
        const { callId, reply: send } = this.waiting
        this.waiting = undefined
        const r = msg.result as { action?: string; content?: { name?: string } } | undefined
        const text = r?.action === 'accept' ? `hello ${r.content?.name}` : 'no answer'
        send({ jsonrpc: '2.0', id: callId, result: { content: [{ type: 'text', text }] } })
      }
      return
    }
    const ok = (result: Record<string, unknown>): void =>
      reply({ jsonrpc: '2.0', id: msg.id, result: this.modern ? { resultType: 'complete', ...result } : result })
    const fail = (code: number, message: string): void => reply({ jsonrpc: '2.0', id: msg.id, error: { code, message } })

    if (this.modern) {
      const version = msg.params?._meta?.[MODERN_META]
      if (msg.method !== 'initialize' && version !== '2026-07-28') this.problems.push(`${msg.method} without _meta version`)
      if (headers && msg.method !== 'initialize') {
        if (headers['mcp-protocol-version'] !== '2026-07-28') this.problems.push(`${msg.method} without the version header`)
        if (headers['mcp-method'] !== msg.method) this.problems.push(`${msg.method} without Mcp-Method`)
        if (msg.method === 'tools/call' && headers['mcp-name'] !== msg.params?.name) this.problems.push('tools/call without Mcp-Name')
        if (headers['mcp-session-id']) this.problems.push('a session id was sent')
      }
      // Over stdio the client sends initialize alongside discovery (it has no status code
      // to tell eras apart, and an older server may never answer discovery), and a
      // stateless server rejects it. Over HTTP it must not be sent at all.
      if (msg.method === 'notifications/initialized') this.problems.push('initialized sent to a stateless server')
      if (msg.method === 'initialize' && headers) this.problems.push('initialize sent to a stateless server over HTTP')
    } else if (msg.method !== 'initialize' && msg.method !== 'server/discover' && msg.params?._meta?.[MODERN_META]) {
      this.problems.push(`${msg.method} carried 2026-07-28 _meta to an older server`)
    }

    switch (msg.method) {
      case 'server/discover':
        if (!this.modern) return fail(-32601, 'Method not found')
        return ok({ supportedVersions: ['2026-07-28'], capabilities: { tools: { listChanged: true } } })
      case 'initialize':
        if (this.modern) return fail(-32601, 'Method not found')
        return ok({ protocolVersion: this.era, capabilities: { tools: { listChanged: true } } })
      case 'tools/list':
        return ok({ tools: this.toolset })
      case 'subscriptions/listen':
        if (!this.modern) return fail(-32601, 'Method not found')
        return reply({
          jsonrpc: '2.0',
          method: 'notifications/subscriptions/acknowledged',
          params: { _meta: { 'io.modelcontextprotocol/subscriptionId': msg.id }, notifications: msg.params?.notifications }
        })
      case 'tools/call': {
        const name = msg.params?.name
        if (name === 'echo') return ok({ content: [{ type: 'text', text: `echo ${JSON.stringify(msg.params?.arguments)}` }] })
        if (name === 'slow') return // never answers
        if (name === 'ask') {
          if (this.modern) {
            const answer = (msg.params?.inputResponses as Record<string, { action?: string; content?: { name?: string } }> | undefined)?.who
            if (!answer) {
              return reply({
                jsonrpc: '2.0',
                id: msg.id,
                result: {
                  resultType: 'input_required',
                  inputRequests: {
                    who: {
                      method: 'elicitation/create',
                      params: { mode: 'form', message: 'Name?', requestedSchema: { type: 'object', properties: { name: { type: 'string' } } } }
                    }
                  },
                  requestState: 'state-1'
                }
              })
            }
            if (msg.params?.requestState !== 'state-1') this.problems.push('requestState was not echoed')
            return ok({ content: [{ type: 'text', text: answer.action === 'accept' ? `hello ${answer.content?.name}` : 'no answer' }] })
          }
          // An older server asks with a request of its own and answers the call after.
          this.waiting = { callId: msg.id, reply }
          return reply({
            jsonrpc: '2.0',
            id: 'el1',
            method: 'elicitation/create',
            params: { message: 'Name?', requestedSchema: { type: 'object', properties: { name: { type: 'string' } } } }
          })
        }
        return fail(-32602, 'unknown tool')
      }
      default:
        return ok({})
    }
  }

  /** The tools changed: the message announcing it, tagged for a stateless subscription. */
  listChanged(subscriptionId?: number | string): Msg {
    return {
      jsonrpc: '2.0',
      method: 'notifications/tools/list_changed',
      ...(subscriptionId !== undefined ? { params: { _meta: { 'io.modelcontextprotocol/subscriptionId': subscriptionId } } } : {})
    }
  }
}

interface Harness {
  server: FakeServer
  connect(onElicit?: (p: unknown) => Promise<{ action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }>): Promise<void>
  client: { tools: Array<{ name: string }>; callTool(n: string, a: Record<string, unknown>, s?: AbortSignal): Promise<string>; close(): void }
  /** Announce a tools change on whatever channel the era uses. */
  announceToolsChanged(): void
  /** Whether the client told the server (on the wire) that request `id` was cancelled. */
  cancelSent(): boolean
  /** Whether the hung call's HTTP request was aborted (HTTP only). */
  hungRequestAborted?: () => boolean
}

function stdioHarness(era: Era): Harness {
  const server = new FakeServer(era)
  const stdout = new EventEmitter()
  const emit = (m: Msg): void => {
    queueMicrotask(() => stdout.emit('data', Buffer.from(`${JSON.stringify(m)}\n`)))
  }
  let listenId: number | string | undefined
  const stdin = Object.assign(new EventEmitter(), {
    write(line: string): boolean {
      const msg = JSON.parse(line.trim()) as Msg
      if (msg.method === 'subscriptions/listen') listenId = msg.id
      server.handle(msg, emit)
      return true
    }
  })
  const child = Object.assign(new EventEmitter(), { stdout, stdin, stderr: new EventEmitter(), kill: () => {} })
  const client = new McpClient((() => child) as unknown as SpawnFn)
  return {
    server,
    client,
    connect: (onElicit) => client.connect({ command: 'fake', ...(onElicit ? { onElicit } : {}) }),
    announceToolsChanged: () => emit(server.listChanged(server.modern ? listenId : undefined)),
    cancelSent: () => server.seen.some((m) => m.method === 'notifications/cancelled')
  }
}

function httpHarness(era: Era): Harness {
  const server = new FakeServer(era)
  const enc = new TextEncoder()
  /** The open change-notification stream: GET (older eras) or subscriptions/listen. */
  let notifyStream: { push: (m: Msg) => void; id?: number | string } | undefined
  let hungSignal: AbortSignal | undefined
  const posts: Msg[] = []
  const fetch: FetchFn = async (_u, init) => {
    const headers = Object.fromEntries(Object.entries((init.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
    const openStream = (onOpen: (push: (m: Msg) => void, close: () => void) => void): Response => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const push = (m: Msg): void => controller.enqueue(enc.encode(`data: ${JSON.stringify(m)}\n\n`))
          let closed = false
          const close = (): void => {
            if (!closed) controller.close()
            closed = true
          }
          init.signal?.addEventListener('abort', () => {
            if (!closed) controller.error(new Error('aborted'))
            closed = true
          })
          onOpen(push, close)
        }
      })
      return new Response(body, { status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }) })
    }
    if (init.method === 'GET') {
      if (server.modern) {
        server.problems.push('GET sent to a stateless server')
        return new Response('', { status: 405 })
      }
      return openStream((push) => (notifyStream = { push }))
    }
    const msg = JSON.parse(init.body as string) as Msg
    posts.push(msg)
    if (msg.method === 'subscriptions/listen' && server.modern) {
      return openStream((push) => {
        notifyStream = { push, id: msg.id }
        server.handle(msg, push, headers)
      })
    }
    if (msg.id === undefined || msg.method === undefined) {
      server.handle(msg, () => {}, headers)
      return new Response('', { status: 202 })
    }
    if (msg.method === 'tools/call' && msg.params?.name === 'slow') hungSignal = init.signal ?? undefined
    // Each request's answer (and any server request before it) goes on its own SSE stream.
    return openStream((push, close) => {
      server.handle(
        msg,
        (m) => {
          push(m)
          if (m.id === msg.id) close()
        },
        headers
      )
    })
  }
  const client = new McpHttpClient(fetch)
  return {
    server,
    client,
    connect: (onElicit) => client.connect({ url: 'https://x.test/mcp', ...(onElicit ? { onElicit } : {}) }),
    announceToolsChanged: () => notifyStream?.push(server.listChanged(notifyStream.id)),
    cancelSent: () => posts.some((m) => m.method === 'notifications/cancelled'),
    hungRequestAborted: () => hungSignal?.aborted === true
  }
}

const TRANSPORTS = { stdio: stdioHarness, http: httpHarness } as const

describe.each(Object.keys(TRANSPORTS) as Array<keyof typeof TRANSPORTS>)('MCP conformance over %s', (transport) => {
  describe.each(ERAS)('against a %s server', (era) => {
    const make = (): Harness => TRANSPORTS[transport](era)
    const modern = era === '2026-07-28'

    it('connects with the right handshake and lists tools', async () => {
      const h = make()
      await h.connect()
      expect(h.client.tools.map((t) => t.name)).toEqual(['echo', 'ask', 'slow'])
      const methods = h.server.seen.map((m) => m.method)
      expect(methods[0]).toBe('server/discover')
      if (modern) {
        if (transport === 'http') expect(methods).not.toContain('initialize')
        expect(methods).not.toContain('notifications/initialized')
      } else {
        expect(methods).toContain('initialize')
        expect(methods).toContain('notifications/initialized')
      }
      expect(h.server.problems).toEqual([])
      h.client.close()
    })

    it('calls a tool', async () => {
      const h = make()
      await h.connect()
      expect(await h.client.callTool('echo', { x: 1 })).toBe('echo {"x":1}')
      expect(h.server.problems).toEqual([])
      h.client.close()
    })

    it('answers an elicitation through the client\'s responder', async () => {
      const h = make()
      const onElicit = vi.fn(async () => ({ action: 'accept' as const, content: { name: 'Ada' } }))
      await h.connect(onElicit)
      const out = await h.client.callTool('ask', {})
      if (era === '2024-11-05') {
        // That version has no elicitation: the client declines the server's request.
        expect(out).toBe('no answer')
        expect(onElicit).not.toHaveBeenCalled()
      } else {
        expect(out).toBe('hello Ada')
        expect(onElicit).toHaveBeenCalledTimes(1)
        expect(onElicit).toHaveBeenCalledWith(expect.objectContaining({ message: 'Name?' }))
      }
      if (modern) {
        const calls = h.server.seen.filter((m) => m.method === 'tools/call')
        expect(calls).toHaveLength(2)
        expect(calls[0].id).not.toBe(calls[1].id)
      }
      expect(h.server.problems).toEqual([])
      h.client.close()
    })

    it('ends a hung call on Stop, telling the server the way its era expects', async () => {
      const h = make()
      await h.connect()
      const stop = new AbortController()
      const call = h.client.callTool('slow', {}, stop.signal)
      await new Promise((r) => setTimeout(r, 10))
      stop.abort()
      await expect(call).rejects.toThrow('cancelled')
      await new Promise((r) => setTimeout(r, 10))
      if (transport === 'http' && modern) {
        // Closing the request's stream is the cancel: no notification is posted.
        expect(h.cancelSent()).toBe(false)
        expect(h.hungRequestAborted?.()).toBe(true)
      } else {
        expect(h.cancelSent()).toBe(true)
      }
      h.client.close()
    })

    it('picks up a tools list change', async () => {
      const h = make()
      await h.connect()
      await new Promise((r) => setTimeout(r, 10)) // the notification channel opens
      if (modern) expect(h.server.seen.some((m) => m.method === 'subscriptions/listen')).toBe(true)
      h.server.toolset = [{ name: 'echo' }, { name: 'fresh' }]
      h.announceToolsChanged()
      await vi.waitFor(() => expect(h.client.tools.map((t) => t.name)).toEqual(['echo', 'fresh']))
      expect(h.server.problems).toEqual([])
      h.client.close()
    })
  })
})

describe('2026-07-28 specifics', () => {
  /** A stateless HTTP server whose tools/list is `tools`, recording each POST's headers. */
  function statelessHttp(tools: unknown[], posts: Array<{ msg: Msg; headers: Record<string, string> }>): FetchFn {
    return async (_u, init) => {
      if (init.method === 'GET') return new Response('', { status: 405 })
      const msg = JSON.parse(init.body as string) as Msg
      const headers = init.headers as Record<string, string>
      posts.push({ msg, headers })
      if (msg.method === 'subscriptions/listen') return new Response('', { status: 405 })
      const result =
        msg.method === 'server/discover'
          ? { resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {} } }
          : msg.method === 'tools/list'
            ? { resultType: 'complete', tools }
            : { resultType: 'complete', content: [{ type: 'text', text: 'ok' }] }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }), {
        status: 200,
        headers: new Headers({ 'content-type': 'application/json', 'mcp-session-id': 'ignored' })
      })
    }
  }

  it('mirrors x-mcp-header parameters into headers and leaves out a tool whose annotations are invalid', async () => {
    const posts: Array<{ msg: Msg; headers: Record<string, string> }> = []
    const client = new McpHttpClient(
      statelessHttp(
        [
          {
            name: 'execute_sql',
            inputSchema: {
              type: 'object',
              properties: { region: { type: 'string', 'x-mcp-header': 'Region' }, query: { type: 'string' } }
            }
          },
          { name: 'broken', inputSchema: { type: 'object', properties: { n: { type: 'number', 'x-mcp-header': 'N' } } } }
        ],
        posts
      )
    )
    await client.connect({ url: 'https://x.test/mcp' })
    expect(client.tools.map((t) => t.name)).toEqual(['execute_sql'])
    expect(client.droppedTools).toEqual([expect.stringContaining('tool "broken"')])
    await client.callTool('execute_sql', { region: 'us-west1', query: 'SELECT 1' })
    const call = posts.find((p) => p.msg.method === 'tools/call')!
    expect(call.headers).toMatchObject({
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'mcp-name': 'execute_sql',
      'mcp-param-region': 'us-west1'
    })
    // No session is kept, even when a server sends an id.
    expect(posts.every((p) => !p.headers['mcp-session-id'])).toBe(true)
    client.close()
  })

  it('fails the connection, without falling back, when the server wants another stateless version', async () => {
    const posts: Msg[] = []
    const fetch: FetchFn = async (_u, init) => {
      const msg = JSON.parse(init.body as string) as Msg
      posts.push(msg)
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32022, message: 'Unsupported protocol version', data: { supported: ['2027-03-01'] } }
        }),
        { status: 400, headers: new Headers({ 'content-type': 'application/json' }) }
      )
    }
    const client = new McpHttpClient(fetch)
    await expect(client.connect({ url: 'https://x.test/mcp' })).rejects.toThrow(/2027-03-01/)
    expect(posts.map((m) => m.method)).toEqual(['server/discover'])
  })

  it('reports a 401 on discovery as a sign-in problem, not as an older server', async () => {
    const fetch: FetchFn = async () => new Response('', { status: 401, headers: new Headers({ 'www-authenticate': 'Bearer' }) })
    const client = new McpHttpClient(fetch)
    await expect(client.connect({ url: 'https://x.test/mcp' })).rejects.toThrow(/HTTP 401/)
  })

  it('over stdio, fails without initializing when discovery answers UnsupportedProtocolVersion', async () => {
    const stdout = new EventEmitter()
    const written: Msg[] = []
    const answer = (m: unknown): void => {
      queueMicrotask(() => stdout.emit('data', Buffer.from(`${JSON.stringify(m)}\n`)))
    }
    const stdin = Object.assign(new EventEmitter(), {
      write(line: string): boolean {
        const msg = JSON.parse(line.trim()) as Msg
        written.push(msg)
        if (msg.method === 'server/discover') {
          answer({ jsonrpc: '2.0', id: msg.id, error: { code: -32022, message: 'no', data: { supported: ['2027-03-01'] } } })
        } else if (msg.method === 'initialize') {
          answer({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } })
        }
        return true
      }
    })
    const child = Object.assign(new EventEmitter(), { stdout, stdin, stderr: new EventEmitter(), kill: () => {} })
    const client = new McpClient((() => child) as unknown as SpawnFn)
    await expect(client.connect({ command: 'fake' })).rejects.toThrow(/2027-03-01/)
    expect(written.map((m) => m.method)).not.toContain('notifications/initialized')
    client.close()
  })
})
