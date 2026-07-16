import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { McpClient, type SpawnFn } from './client'

interface ToolDecl {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

/**
 * A fake MCP server over an in-memory stdio transport: it auto-responds to
 * initialize / tools/list / tools/call with the configured tools and result.
 */
function fakeServer(tools: ToolDecl[], callResult: (params: unknown) => unknown): SpawnFn {
  const stdout = new EventEmitter()
  const reply = (id: number, result: unknown): void => {
    queueMicrotask(() =>
      stdout.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`))
    )
  }
  const stdin = {
    write(line: string): boolean {
      const msg = JSON.parse(line.trim()) as { id?: number; method: string; params?: unknown }
      if (msg.id === undefined) return true // a notification
      if (msg.method === 'initialize') reply(msg.id, { protocolVersion: '2024-11-05', capabilities: {} })
      else if (msg.method === 'tools/list') reply(msg.id, { tools })
      else if (msg.method === 'tools/call') reply(msg.id, callResult(msg.params))
      return true
    }
  }
  const child = Object.assign(new EventEmitter(), { stdout, stdin, stderr: new EventEmitter(), kill: () => {} })
  return (() => child) as unknown as SpawnFn
}

describe('McpClient (fake stdio server)', () => {
  it('initializes and lists tools', async () => {
    const client = new McpClient(
      fakeServer([{ name: 'echo', description: 'Echoes input' }], () => ({}))
    )
    await client.connect({ command: 'fake' })
    expect(client.tools.map((t) => t.name)).toEqual(['echo'])
    client.close()
  })

  it('calls a tool and flattens the text result', async () => {
    const client = new McpClient(
      fakeServer([{ name: 'echo' }], (params) => ({
        content: [{ type: 'text', text: `got:${JSON.stringify((params as { arguments: unknown }).arguments)}` }]
      }))
    )
    await client.connect({ command: 'fake' })
    const out = await client.callTool('echo', { x: 1 })
    expect(out).toBe('got:{"x":1}')
    client.close()
  })

  it('marks an error result', async () => {
    const client = new McpClient(
      fakeServer([{ name: 'boom' }], () => ({ content: [{ type: 'text', text: 'nope' }], isError: true }))
    )
    await client.connect({ command: 'fake' })
    const out = await client.callTool('boom', {})
    expect(out).toContain('nope')
    expect(out).toContain('error')
    client.close()
  })

  it('correlates concurrent requests by id', async () => {
    const client = new McpClient(
      fakeServer([{ name: 't' }], (p) => ({ content: [{ type: 'text', text: String((p as { arguments: { n: number } }).arguments.n) }] }))
    )
    await client.connect({ command: 'fake' })
    const [a, b] = await Promise.all([client.callTool('t', { n: 1 }), client.callTool('t', { n: 2 })])
    expect([a, b].sort()).toEqual(['1', '2'])
    client.close()
  })

  it('spawns the server with a sanitized env (secrets stripped, opts.env re-added)', async () => {
    let captured: { env?: NodeJS.ProcessEnv; cwd?: string } | undefined
    const stdout = new EventEmitter()
    const stdin = {
      write(line: string): boolean {
        const msg = JSON.parse(line.trim()) as { id?: number; method: string }
        if (msg.id === undefined) return true
        const result = msg.method === 'tools/list' ? { tools: [{ name: 'echo' }] } : {}
        queueMicrotask(() =>
          stdout.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`))
        )
        return true
      }
    }
    const child = Object.assign(new EventEmitter(), { stdout, stdin, stderr: new EventEmitter(), kill: () => {} })
    const spawnFn = ((_cmd: string, _args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string }) => {
      captured = options
      return child
    }) as unknown as SpawnFn

    // A secret exported into the launching shell must NOT reach the MCP server…
    process.env.HOUSTON_TEST_LEAK_TOKEN = 'ghp_should_not_leak'
    try {
      const client = new McpClient(spawnFn)
      await client.connect({ command: 'fake', env: { MY_SERVER_TOKEN: 'legit-config-token' } })
      client.close()
    } finally {
      delete process.env.HOUSTON_TEST_LEAK_TOKEN
    }

    expect(captured?.env?.HOUSTON_TEST_LEAK_TOKEN).toBeUndefined()
    // …but a token the server config supplies via opts.env still does.
    expect(captured?.env?.MY_SERVER_TOKEN).toBe('legit-config-token')
    // Non-secret ambient vars (e.g. PATH) pass through so the server can be found.
    expect(captured?.env?.PATH).toBe(process.env.PATH)
  })

  it('answers a server ping and declines unsupported server requests', async () => {
    const client = new McpClient(fakeServer([{ name: 'echo' }], () => ({})))
    await client.connect({ command: 'fake' })
    const written: unknown[] = []
    // Reach past the fake: capture what the client writes from here on.
    const child = (client as unknown as { child: { stdin: { write: (l: string) => boolean } } }).child
    const origWrite = child.stdin.write.bind(child.stdin)
    child.stdin.write = (line: string): boolean => {
      written.push(JSON.parse(line.trim()))
      return origWrite(line)
    }

    client.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 'p1', method: 'ping' }))
    client.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 'e1', method: 'elicitation/create', params: {} }))

    expect(written[0]).toEqual({ jsonrpc: '2.0', id: 'p1', result: {} })
    const decline = written[1] as { id: string; error: { code: number } }
    expect(decline.id).toBe('e1')
    expect(decline.error.code).toBe(-32601)
    client.close()
  })

  it('re-fetches the tool list on notifications/tools/list_changed', async () => {
    let toolset = [{ name: 'one' }]
    const stdout = new EventEmitter()
    const stdin = {
      write(line: string): boolean {
        const msg = JSON.parse(line.trim()) as { id?: number; method: string }
        if (msg.id === undefined) return true
        const result = msg.method === 'tools/list' ? { tools: toolset } : {}
        queueMicrotask(() =>
          stdout.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`))
        )
        return true
      }
    }
    const child = Object.assign(new EventEmitter(), { stdout, stdin, stderr: new EventEmitter(), kill: () => {} })
    const client = new McpClient((() => child) as unknown as SpawnFn)
    await client.connect({ command: 'fake' })
    expect(client.tools.map((t) => t.name)).toEqual(['one'])

    toolset = [{ name: 'one' }, { name: 'two' }]
    client.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }))
    await new Promise((r) => setTimeout(r, 10))
    expect(client.tools.map((t) => t.name)).toEqual(['one', 'two'])
    client.close()
  })

  it('lists and fetches prompts when the server declares the capability', async () => {
    const stdout = new EventEmitter()
    const stdin = {
      write(line: string): boolean {
        const msg = JSON.parse(line.trim()) as { id?: number; method: string }
        if (msg.id === undefined) return true
        let result: unknown = {}
        if (msg.method === 'initialize') result = { capabilities: { prompts: {} } }
        else if (msg.method === 'tools/list') result = { tools: [] }
        else if (msg.method === 'prompts/list')
          result = {
            prompts: [
              { name: 'review', description: 'Review code', arguments: [{ name: 'path', required: true }] }
            ]
          }
        else if (msg.method === 'prompts/get')
          result = {
            description: 'A review request',
            messages: [{ role: 'user', content: [{ type: 'text', text: 'Please review src/x.ts' }] }]
          }
        queueMicrotask(() =>
          stdout.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`))
        )
        return true
      }
    }
    const child = Object.assign(new EventEmitter(), { stdout, stdin, stderr: new EventEmitter(), kill: () => {} })
    const client = new McpClient((() => child) as unknown as SpawnFn)
    await client.connect({ command: 'fake' })
    expect(client.prompts).toEqual([
      { name: 'review', description: 'Review code', arguments: [{ name: 'path', required: true }] }
    ])
    const text = await client.getPrompt('review', { path: 'src/x.ts' })
    expect(text).toBe('A review request\n\nuser: Please review src/x.ts')
    client.close()
  })

  it('sends a progress token on tools/call and stays alive while progress flows', async () => {
    let callParams: Record<string, unknown> | undefined
    const stdout = new EventEmitter()
    const emit = (obj: unknown): void => {
      stdout.emit('data', Buffer.from(`${JSON.stringify(obj)}\n`))
    }
    const stdin = {
      write(line: string): boolean {
        const msg = JSON.parse(line.trim()) as { id?: number; method: string; params?: Record<string, unknown> }
        if (msg.id === undefined) return true
        if (msg.method === 'tools/call') {
          callParams = msg.params
          // Never answer: the test drives progress + response by hand.
          return true
        }
        const result = msg.method === 'tools/list' ? { tools: [{ name: 'slow' }] } : {}
        queueMicrotask(() => emit({ jsonrpc: '2.0', id: msg.id, result }))
        return true
      }
    }
    const child = Object.assign(new EventEmitter(), { stdout, stdin, stderr: new EventEmitter(), kill: () => {} })
    const client = new McpClient((() => child) as unknown as SpawnFn)
    await client.connect({ command: 'fake' })

    const call = client.callTool('slow', {})
    await new Promise((r) => setTimeout(r, 5))
    const meta = callParams?._meta as { progressToken?: number }
    expect(meta?.progressToken).toBeTypeOf('number')
    // Feed a progress notification, then the response; the call must resolve.
    emit({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: meta.progressToken, progress: 1 } })
    emit({ jsonrpc: '2.0', id: meta.progressToken, result: { content: [{ type: 'text', text: 'done' }] } })
    expect(await call).toBe('done')
    client.close()
  })

  it('marks the client closed on process exit so later calls fail fast', async () => {
    const stdout = new EventEmitter()
    const stdin = {
      write(line: string): boolean {
        const msg = JSON.parse(line.trim()) as { id?: number; method: string }
        if (msg.id === undefined) return true
        const result = msg.method === 'tools/list' ? { tools: [{ name: 'echo' }] } : {}
        queueMicrotask(() =>
          stdout.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`))
        )
        return true
      }
    }
    const child = Object.assign(new EventEmitter(), { stdout, stdin, stderr: new EventEmitter(), kill: () => {} })
    const client = new McpClient((() => child) as unknown as SpawnFn)
    await client.connect({ command: 'fake' })
    expect(client.isClosed).toBe(false)

    child.emit('exit') // server died
    expect(client.isClosed).toBe(true)
    // Should reject immediately (not wait out the 120s call timeout).
    await expect(client.callTool('echo', {})).rejects.toThrow(/closed/)
  })
})
