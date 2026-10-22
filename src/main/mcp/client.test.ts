import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { version as PKG_VERSION } from '../../../package.json'
import { McpClient, type SpawnFn } from './client'
import { LATEST_PROTOCOL_VERSION, McpUnsupportedProtocolError } from './version'

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
  const stdin = Object.assign(new EventEmitter(), {
    write(line: string): boolean {
      const msg = JSON.parse(line.trim()) as { id?: number; method: string; params?: unknown }
      if (msg.id === undefined) return true // a notification
      if (msg.method === 'initialize') reply(msg.id, { protocolVersion: '2024-11-05', capabilities: {} })
      else if (msg.method === 'tools/list') reply(msg.id, { tools })
      else if (msg.method === 'tools/call') reply(msg.id, callResult(msg.params))
      return true
    }
  })
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
    const stdin = Object.assign(new EventEmitter(), {
      write(line: string): boolean {
        const msg = JSON.parse(line.trim()) as { id?: number; method: string }
        if (msg.id === undefined) return true
        const result = msg.method === 'tools/list' ? { tools: [{ name: 'echo' }] } : {}
        queueMicrotask(() =>
          stdout.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`))
        )
        return true
      }
    })
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
    const stdin = Object.assign(new EventEmitter(), {
      write(line: string): boolean {
        const msg = JSON.parse(line.trim()) as { id?: number; method: string }
        if (msg.id === undefined) return true
        const result = msg.method === 'tools/list' ? { tools: toolset } : {}
        queueMicrotask(() =>
          stdout.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`))
        )
        return true
      }
    })
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
    const stdin = Object.assign(new EventEmitter(), {
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
    })
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
    const stdin = Object.assign(new EventEmitter(), {
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
    })
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
    const stdin = Object.assign(new EventEmitter(), {
      write(line: string): boolean {
        const msg = JSON.parse(line.trim()) as { id?: number; method: string }
        if (msg.id === undefined) return true
        const result = msg.method === 'tools/list' ? { tools: [{ name: 'echo' }] } : {}
        queueMicrotask(() =>
          stdout.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`))
        )
        return true
      }
    })
    const child = Object.assign(new EventEmitter(), { stdout, stdin, stderr: new EventEmitter(), kill: () => {} })
    const client = new McpClient((() => child) as unknown as SpawnFn)
    await client.connect({ command: 'fake' })
    expect(client.isClosed).toBe(false)

    child.emit('exit') // server died
    expect(client.isClosed).toBe(true)
    // Should reject immediately (not wait out the 120s call timeout).
    await expect(client.callTool('echo', {})).rejects.toThrow(/closed/)
  })

  it('keeps a multibyte character that arrives split across two stdout chunks', async () => {
    // 'é' is 0xC3 0xA9. A server's reply can be cut anywhere by the pipe; decoding each
    // chunk on its own turned the two halves into replacement characters.
    const stdout = new EventEmitter()
    const stdin = Object.assign(new EventEmitter(), {
      write(line: string): boolean {
        const msg = JSON.parse(line.trim()) as { id?: number; method: string }
        if (msg.id === undefined) return true
        const result =
          msg.method === 'tools/list'
            ? { tools: [{ name: 'echo' }] }
            : msg.method === 'tools/call'
              ? { content: [{ type: 'text', text: 'café' }] }
              : {}
        const bytes = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`)
        const cut = bytes.indexOf(0xa9)
        queueMicrotask(() => {
          if (cut === -1) {
            stdout.emit('data', bytes)
            return
          }
          stdout.emit('data', bytes.subarray(0, cut))
          stdout.emit('data', bytes.subarray(cut))
        })
        return true
      }
    })
    const child = Object.assign(new EventEmitter(), { stdout, stdin, stderr: new EventEmitter(), kill: () => {} })
    const client = new McpClient((() => child) as unknown as SpawnFn)
    await client.connect({ command: 'fake' })
    expect(await client.callTool('echo', {})).toBe('café')
    client.close()
  })

  it('treats a broken stdin pipe like the server exiting instead of throwing', async () => {
    let answer = true
    const stdout = new EventEmitter()
    const stdin = Object.assign(new EventEmitter(), {
      write(line: string): boolean {
        const msg = JSON.parse(line.trim()) as { id?: number; method: string }
        if (msg.id === undefined || !answer) return true
        const result = msg.method === 'tools/list' ? { tools: [{ name: 'echo' }] } : {}
        queueMicrotask(() =>
          stdout.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`))
        )
        return true
      }
    })
    const child = Object.assign(new EventEmitter(), { stdout, stdin, stderr: new EventEmitter(), kill: () => {} })
    const client = new McpClient((() => child) as unknown as SpawnFn)
    await client.connect({ command: 'fake' })

    // The server stops reading: the in-flight call's write fails with EPIPE, which Node
    // delivers as an 'error' event on stdin. With no listener, emit() throws, which in
    // the app is an uncaught exception.
    answer = false
    const call = client.callTool('echo', {})
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
    expect(() => stdin.emit('error', epipe)).not.toThrow()
    await expect(call).rejects.toThrow(/stopped reading input/)
    expect(client.isClosed).toBe(true)
  })
})

/**
 * A fake stdio server that answers initialize with `initResult` and records the
 * initialize params plus everything the client writes afterwards.
 */
interface Seen {
  init?: Record<string, unknown>
  written: Array<Record<string, unknown>>
}

function negotiatingSpawn(initResult: unknown, seen: Seen): SpawnFn {
  const stdout = new EventEmitter()
  const reply = (id: number, result: unknown): void =>
    void queueMicrotask(() => stdout.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)))
  const stdin = Object.assign(new EventEmitter(), {
    write(line: string): boolean {
      const msg = JSON.parse(line.trim()) as Record<string, unknown> & { id?: number; method?: string }
      seen.written.push(msg)
      if (msg.id === undefined || msg.method === undefined) return true
      if (msg.method === 'initialize') {
        seen.init = msg.params as Record<string, unknown>
        reply(msg.id, initResult)
      } else reply(msg.id, msg.method === 'tools/list' ? { tools: [] } : {})
      return true
    }
  })
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stdin,
    stderr: new EventEmitter(),
    kill: () => {}
  })
  return (() => child) as unknown as SpawnFn
}

describe('McpClient protocol-version negotiation', () => {
  const onElicit = async (): Promise<{ action: 'accept'; content: Record<string, unknown> }> => ({
    action: 'accept',
    content: { ok: true }
  })
  const elicit = (client: McpClient): void =>
    client.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 'el1', method: 'elicitation/create', params: {} }))
  const replyTo = (seen: Seen, id: string): Record<string, unknown> | undefined =>
    seen.written.find((m) => m.id === id && m.method === undefined)

  it('requests the latest version and reports the real app version', async () => {
    const seen: Seen = { written: [] }
    const client = new McpClient(negotiatingSpawn({ protocolVersion: '2025-06-18', capabilities: {} }, seen))
    await client.connect({ command: 'fake' })
    expect(seen.init?.protocolVersion).toBe(LATEST_PROTOCOL_VERSION)
    expect(seen.init?.clientInfo).toEqual({ name: 'Houston', version: PKG_VERSION })
    client.close()
  })

  it('answers elicitation from a 2025-06-18 server', async () => {
    const seen: Seen = { written: [] }
    const client = new McpClient(negotiatingSpawn({ protocolVersion: '2025-06-18', capabilities: {} }, seen))
    await client.connect({ command: 'fake', onElicit })
    expect(seen.init?.capabilities).toEqual({ elicitation: {} })
    elicit(client)
    await new Promise((r) => setTimeout(r, 10))
    expect(replyTo(seen, 'el1')?.result).toEqual({ action: 'accept', content: { ok: true } })
    client.close()
  })

  it('stops answering elicitation when a server negotiates down to 2024-11-05', async () => {
    const seen: Seen = { written: [] }
    const client = new McpClient(negotiatingSpawn({ protocolVersion: '2024-11-05', capabilities: {} }, seen))
    await client.connect({ command: 'fake', onElicit })
    expect(client.tools).toEqual([])
    elicit(client)
    await new Promise((r) => setTimeout(r, 10))
    expect((replyTo(seen, 'el1')?.error as { code: number }).code).toBe(-32601)
    client.close()
  })

  it('fails the connection on an unsupported version, before initialized is sent', async () => {
    const seen: Seen = { written: [] }
    const client = new McpClient(negotiatingSpawn({ protocolVersion: '2023-01-01', capabilities: {} }, seen))
    await expect(client.connect({ command: 'fake' })).rejects.toThrow(McpUnsupportedProtocolError)
    expect(seen.written.some((m) => m.method === 'notifications/initialized')).toBe(false)
  })
})

describe('McpClient (real stdio process)', () => {
  // A server that logs a lot to stderr before answering, as the stdio transport allows.
  // Its stderr pipe holds only ~64 KB, so if the client never reads it the server
  // blocks on the write and never replies.
  const chattyServer = String.raw`
    process.stderr.write('x'.repeat(1024 * 1024) + '\nstarted\n', () => {
      let buf = ''
      process.stdin.on('data', (c) => {
        buf += c
        let nl
        while ((nl = buf.indexOf('\n')) >= 0) {
          const msg = JSON.parse(buf.slice(0, nl))
          buf = buf.slice(nl + 1)
          if (msg.id === undefined) continue
          const result = msg.method === 'tools/list' ? { tools: [{ name: 'echo' }] } : { capabilities: {} }
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n')
        }
      })
    })
  `

  it('keeps reading a server that writes more stderr than a pipe holds', async () => {
    const client = new McpClient()
    try {
      await client.connect({ command: process.execPath, args: ['-e', chattyServer] })
      expect(client.tools.map((t) => t.name)).toEqual(['echo'])
    } finally {
      client.close()
    }
  }, 15_000)

  it("names the server's last stderr line when it exits", async () => {
    const client = new McpClient()
    await expect(
      client.connect({
        command: process.execPath,
        args: ['-e', "process.stderr.write('booting\\nError: missing API_TOKEN\\n'); process.exit(1)"]
      })
    ).rejects.toThrow('MCP server process exited: Error: missing API_TOKEN')
    client.close()
  }, 15_000)
})
