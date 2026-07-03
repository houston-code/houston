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
