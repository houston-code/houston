import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { version as PKG_VERSION } from '../../../package.json'
import { MAX_MCP_MESSAGE_CHARS } from './sse-client'
import {
  McpClient,
  killLiveMcpGroups,
  parseMcpPromptList,
  parseMcpResourceList,
  parseMcpToolList,
  type SpawnFn
} from './client'
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

describe('2025-11-25 list metadata', () => {
  it('accepts icons and dotted tool names, and keeps no icon URL', () => {
    const icons = [{ src: 'https://example.com/i.png', mimeType: 'image/png', sizes: ['48x48'] }]
    const tools = parseMcpToolList({ tools: [{ name: 'files.read', title: 'Read', icons, inputSchema: { type: 'object' } }] })
    expect(tools).toEqual([{ name: 'files.read', inputSchema: { type: 'object' } }])
    expect(parseMcpResourceList({ resources: [{ uri: 'file:///a', name: 'a', icons }] })).toEqual([{ uri: 'file:///a', name: 'a' }])
    expect(JSON.stringify(parseMcpPromptList({ prompts: [{ name: 'p', icons }] }))).not.toContain('example.com')
  })
})
/** A two-page answer to each `*\/list` method: `one` on the first page, `two` behind cursor `page-2`. */
function pagedListResult(method: string, cursor: unknown): unknown {
  const kind = method.split('/')[0]
  if (!['tools', 'resources', 'prompts'].includes(kind) || !method.endsWith('/list')) return {}
  const entry = (n: string): unknown => (kind === 'resources' ? { uri: `file:///${n}` } : { name: n })
  return cursor === undefined ? { [kind]: [entry('one')], nextCursor: 'page-2' } : { [kind]: [entry('two')] }
}

/** A stdio server that answers every request with `answer(method, params)`. */
function fakeListServer(answer: (method: string, params: unknown) => unknown): SpawnFn {
  const stdout = new EventEmitter()
  const stdin = Object.assign(new EventEmitter(), {
    write(line: string): boolean {
      const msg = JSON.parse(line.trim()) as { id?: number; method: string; params?: unknown }
      if (msg.id === undefined) return true
      const result = msg.method === 'initialize' ? { protocolVersion: '2024-11-05', capabilities: {} } : answer(msg.method, msg.params)
      queueMicrotask(() =>
        stdout.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`))
      )
      return true
    }
  })
  const child = Object.assign(new EventEmitter(), { stdout, stdin, stderr: new EventEmitter(), kill: () => {} })
  return (() => child) as unknown as SpawnFn
}

describe('McpClient (fake stdio server)', () => {
  it('launches a Windows .cmd shim (npx) through cmd.exe with its arguments intact', async () => {
    const inner = fakeServer([{ name: 'echo' }], () => ({}))
    const spawned: Array<{ command: string; args: string[]; verbatim?: boolean; cwd?: string }> = []
    const spawnFn: SpawnFn = (command, args, options) => {
      spawned.push({ command, args, verbatim: options.windowsVerbatimArguments, cwd: options.cwd })
      return inner(command, args, options)
    }
    const client = new McpClient(spawnFn, {
      platform: 'win32',
      exists: (p) => p === 'C:\\nodejs\\npx.cmd',
      comspec: 'C:\\Windows\\system32\\cmd.exe'
    })
    await client.connect({
      command: 'npx',
      args: ['-y', 'some-server', 'C:\\data dir'],
      env: { PATH: 'C:\\nodejs', PATHEXT: '.EXE;.CMD' },
      cwd: 'C:\\work'
    })
    expect(spawned).toEqual([
      {
        command: 'C:\\Windows\\system32\\cmd.exe',
        args: ['/d', '/v:off', '/s', '/c', '""C:\\nodejs\\npx.cmd" "-y" "some-server" "C:\\data dir""'],
        verbatim: true,
        cwd: 'C:\\work'
      }
    ])
    expect(client.tools.map((t) => t.name)).toEqual(['echo'])
    client.close()
  })

  it('on Windows, refuses a command that resolves nowhere without spawning it (no cwd search)', async () => {
    const spawned: string[] = []
    const spawnFn: SpawnFn = (command, args, options) => {
      spawned.push(command)
      return fakeServer([], () => ({}))(command, args, options)
    }
    // C:\work\npx.exe exists, but the cwd is never searched for a bare name.
    const client = new McpClient(spawnFn, {
      platform: 'win32',
      exists: (p) => p === 'C:\\work\\npx.exe',
      comspec: 'C:\\Windows\\system32\\cmd.exe'
    })
    await expect(
      client.connect({ command: 'npx', env: { PATH: 'C:\\nodejs', PATHEXT: '.EXE;.CMD' }, cwd: 'C:\\work' })
    ).rejects.toThrow(/not found on PATH: npx/)
    expect(spawned).toEqual([])
  })

  it('initializes and lists tools', async () => {
    const client = new McpClient(
      fakeServer([{ name: 'echo', description: 'Echoes input' }], () => ({}))
    )
    await client.connect({ command: 'fake' })
    expect(client.tools.map((t) => t.name)).toEqual(['echo'])
    client.close()
  })

  it('follows nextCursor through every page of tools, resources and prompts', async () => {
    const stdout = new EventEmitter()
    const asked: Array<{ method: string; cursor?: unknown }> = []
    const stdin = Object.assign(new EventEmitter(), {
      write(line: string): boolean {
        const msg = JSON.parse(line.trim()) as { id?: number; method: string; params?: { cursor?: unknown } }
        if (msg.id === undefined) return true
        if (msg.method.endsWith('/list')) asked.push({ method: msg.method, cursor: msg.params?.cursor })
        const result =
          msg.method === 'initialize'
            ? { protocolVersion: '2025-06-18', capabilities: { resources: {}, prompts: {} } }
            : pagedListResult(msg.method, msg.params?.cursor)
        queueMicrotask(() =>
          stdout.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`))
        )
        return true
      }
    })
    const child = Object.assign(new EventEmitter(), { stdout, stdin, stderr: new EventEmitter(), kill: () => {} })
    const client = new McpClient((() => child) as unknown as SpawnFn)
    await client.connect({ command: 'fake' })
    expect(client.tools.map((t) => t.name)).toEqual(['one', 'two'])
    expect(client.resources.map((r) => r.uri)).toEqual(['file:///one', 'file:///two'])
    expect(client.prompts.map((p) => p.name)).toEqual(['one', 'two'])
    expect(client.listNotes).toEqual({})
    expect(asked).toEqual([
      { method: 'tools/list', cursor: undefined },
      { method: 'tools/list', cursor: 'page-2' },
      { method: 'resources/list', cursor: undefined },
      { method: 'resources/list', cursor: 'page-2' },
      { method: 'prompts/list', cursor: undefined },
      { method: 'prompts/list', cursor: 'page-2' }
    ])
    client.close()
  })

  it('notes a tool list cut short by a repeated cursor', async () => {
    const client = new McpClient(
      fakeListServer((method) => (method === 'tools/list' ? { tools: [{ name: 'a' }], nextCursor: 'again' } : {}))
    )
    await client.connect({ command: 'fake' })
    expect(client.tools.map((t) => t.name)).toEqual(['a', 'a'])
    expect(client.listNotes.tools).toMatch(/repeated a page cursor/)
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

  /** A fake server whose every reply is cut into pieces by `split`, which may also batch several lines. */
  function choppedServer(callText: string, split: (bytes: Buffer) => Buffer[]): { client: McpClient; killed: () => boolean } {
    const stdout = new EventEmitter()
    let killed = false
    const stdin = Object.assign(new EventEmitter(), {
      write(line: string): boolean {
        const msg = JSON.parse(line.trim()) as { id?: number; method: string }
        if (msg.id === undefined) return true
        const result =
          msg.method === 'tools/list'
            ? { tools: [{ name: 'echo' }] }
            : msg.method === 'tools/call'
              ? { content: [{ type: 'text', text: callText }] }
              : {}
        // A notification first, then the reply, so one chunk can carry the end of one
        // line and the start of the next.
        const bytes = Buffer.from(
          `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: {} })}\n${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`
        )
        queueMicrotask(() => {
          for (const piece of split(bytes)) stdout.emit('data', piece)
        })
        return true
      }
    })
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stdin,
      stderr: new EventEmitter(),
      kill: () => {
        killed = true
      }
    })
    return { client: new McpClient((() => child) as unknown as SpawnFn), killed: () => killed }
  }

  it('reads replies cut at random points, including inside a character and across lines', async () => {
    let seed = 9
    const rnd = (): number => ((seed = (seed * 1664525 + 1013904223) >>> 0), seed / 2 ** 32)
    const text = `naïve café ✓ 世界 ${'x'.repeat(3000)}`
    const { client } = choppedServer(text, (bytes) => {
      const out: Buffer[] = []
      for (let i = 0; i < bytes.length; ) {
        const n = 1 + Math.floor(rnd() * 40)
        out.push(bytes.subarray(i, i + n))
        i += n
      }
      return out
    })
    await client.connect({ command: 'fake' })
    expect(await client.callTool('echo', {})).toBe(text)
    expect(await client.callTool('echo', {})).toBe(text)
    client.close()
  })

  it('drops a server that sends a message past the size cap instead of buffering it', async () => {
    const { client, killed } = choppedServer('ok', (bytes) => [bytes])
    await client.connect({ command: 'fake' })
    const call = client.callTool('echo', {})
    // The server starts a message and never ends it.
    const stdout = (client as unknown as { child: { stdout: EventEmitter } }).child.stdout
    const block = Buffer.alloc(1024 * 1024, 'a')
    for (let i = 0; i <= MAX_MCP_MESSAGE_CHARS / block.length; i++) stdout.emit('data', block)
    await expect(call).rejects.toThrow(/larger than/)
    expect(killed()).toBe(true)
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

describe.skipIf(process.platform === 'win32')('McpClient close (POSIX process group)', () => {
  /**
   * A server that starts a long-lived helper of its own (as `npx`/`uvx`/`sh -c`
   * launchers do) and names the helper's pid as its one tool. `helperIgnoresTerm`
   * makes both the helper and the server ignore SIGTERM, so only SIGKILL ends them.
   */
  const serverWithHelper = (helperIgnoresTerm: boolean): string => {
    const trap = helperIgnoresTerm ? "process.on('SIGTERM', () => {});" : ''
    return String.raw`
      ${trap}
      const { spawn } = require('node:child_process')
      // The helper says when its SIGTERM handler is in place; the server only starts
      // answering after that, so close() can't land before the handler does.
      const helper = spawn(process.execPath, ['-e', ${JSON.stringify(`${trap} process.stdout.write('ready'); setInterval(() => {}, 1e6)`)}], { stdio: ['ignore', 'pipe', 'ignore'] })
      let buf = ''
      helper.stdout.once('data', () => process.stdin.on('data', (c) => {
        buf += c
        let nl
        while ((nl = buf.indexOf('\n')) >= 0) {
          const msg = JSON.parse(buf.slice(0, nl))
          buf = buf.slice(nl + 1)
          if (msg.id === undefined) continue
          const result = msg.method === 'tools/list' ? { tools: [{ name: 'pid-' + helper.pid }] } : { capabilities: {} }
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n')
        }
      }))
    `
  }

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  async function goneWithin(pid: number, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (!alive(pid)) return true
      await new Promise((r) => setTimeout(r, 50))
    }
    return !alive(pid)
  }

  for (const ignoresTerm of [false, true]) {
    it(`stops the server's own child processes on close${ignoresTerm ? ' (SIGKILL after the grace)' : ''}`, async () => {
      const client = new McpClient()
      let helperPid = 0
      try {
        await client.connect({ command: process.execPath, args: ['-e', serverWithHelper(ignoresTerm)] })
        helperPid = Number(client.tools[0]?.name.replace('pid-', ''))
        expect(helperPid).toBeGreaterThan(0)
        expect(alive(helperPid)).toBe(true)
        client.close()
        expect(await goneWithin(helperPid, 6_000)).toBe(true)
      } finally {
        client.close()
        if (helperPid && alive(helperPid)) process.kill(helperPid, 'SIGKILL')
      }
    }, 15_000)
  }

  it('kills servers still running when Houston exits, even ones never closed', async () => {
    const client = new McpClient()
    let helperPid = 0
    try {
      await client.connect({ command: process.execPath, args: ['-e', serverWithHelper(true)] })
      helperPid = Number(client.tools[0]?.name.replace('pid-', ''))
      expect(alive(helperPid)).toBe(true)
      // What the process 'exit' hook runs: no grace, since nothing runs after it.
      killLiveMcpGroups()
      expect(await goneWithin(helperPid, 1_500)).toBe(true)
    } finally {
      client.close()
      if (helperPid && alive(helperPid)) process.kill(helperPid, 'SIGKILL')
    }
  }, 15_000)
})

/** How a promise settled within `ms`, or that it had not by then. */
async function settlesWithin<T>(
  p: Promise<T>,
  ms: number
): Promise<{ settled: boolean; value?: T; error?: unknown }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<{ settled: boolean }>((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), ms)
  })
  try {
    return await Promise.race([
      p.then(
        (value) => ({ settled: true, value }),
        (error: unknown) => ({ settled: true, error })
      ),
      late
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * A stdio server that completes the handshake (declaring resources and prompts) and
 * then never answers anything else, recording every message the client writes.
 */
function hangingSpawn(written: Array<Record<string, unknown>>): {
  spawn: SpawnFn
  reply: (id: unknown, result: unknown) => void
} {
  const stdout = new EventEmitter()
  const reply = (id: unknown, result: unknown): void => {
    stdout.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`))
  }
  const stdin = Object.assign(new EventEmitter(), {
    write(line: string): boolean {
      const msg = JSON.parse(line.trim()) as Record<string, unknown> & { id?: number; method?: string }
      written.push(msg)
      if (msg.id === undefined) return true
      let result: unknown
      if (msg.method === 'initialize') result = { capabilities: { resources: {}, prompts: {} } }
      else if (msg.method === 'tools/list') result = { tools: [{ name: 'slow' }] }
      else if (msg.method === 'resources/list') result = { resources: [] }
      else if (msg.method === 'prompts/list') result = { prompts: [] }
      else return true // tools/call, resources/read, prompts/get: never answered
      queueMicrotask(() => reply(msg.id, result))
      return true
    }
  })
  const child = Object.assign(new EventEmitter(), { stdout, stdin, stderr: new EventEmitter(), kill: () => {} })
  return { spawn: (() => child) as unknown as SpawnFn, reply }
}

describe('McpClient cancellation', () => {
  const cancels = (written: Array<Record<string, unknown>>): Array<Record<string, unknown>> =>
    written.filter((m) => m.method === 'notifications/cancelled')

  it('settles a hung tools/call as soon as its signal aborts, and tells the server', async () => {
    const written: Array<Record<string, unknown>> = []
    const client = new McpClient(hangingSpawn(written).spawn)
    try {
      await client.connect({ command: 'fake' })
      const stop = new AbortController()
      const call = client.callTool('slow', {}, stop.signal)
      await new Promise((r) => setTimeout(r, 5))
      const sent = written.find((m) => m.method === 'tools/call')
      expect(sent).toBeDefined()

      const t0 = Date.now()
      stop.abort()
      const outcome = await settlesWithin(call, 1_000)
      expect(outcome.settled).toBe(true)
      expect(Date.now() - t0).toBeLessThan(100)
      expect(outcome.error).toBeInstanceOf(Error)
      expect((outcome.error as Error).message).toMatch(/cancel/i)

      // The MCP cancellation notification: the request's id and a reason, no id of its own.
      const [cancel] = cancels(written)
      expect(cancel).toMatchObject({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: sent!.id, reason: expect.any(String) }
      })
      expect(cancel).not.toHaveProperty('id')
      // Stopping one call is not a dead server.
      expect(client.isClosed).toBe(false)
    } finally {
      client.close()
    }
  })

  it('ignores the late answer to a cancelled call and keeps serving new ones', async () => {
    const written: Array<Record<string, unknown>> = []
    const server = hangingSpawn(written)
    const client = new McpClient(server.spawn)
    try {
      await client.connect({ command: 'fake' })
      const stop = new AbortController()
      const call = client.callTool('slow', {}, stop.signal)
      await new Promise((r) => setTimeout(r, 5))
      const firstId = written.find((m) => m.method === 'tools/call')!.id
      stop.abort()
      expect((await settlesWithin(call, 1_000)).error).toBeInstanceOf(Error)
      expect(() => server.reply(firstId, { content: [{ type: 'text', text: 'late' }] })).not.toThrow()

      const next = client.callTool('slow', {})
      await new Promise((r) => setTimeout(r, 5))
      const nextId = written.filter((m) => m.method === 'tools/call')[1]!.id
      server.reply(nextId, { content: [{ type: 'text', text: 'fresh' }] })
      expect(await next).toBe('fresh')
    } finally {
      client.close()
    }
  })

  it('never sends a call whose signal has already aborted', async () => {
    const written: Array<Record<string, unknown>> = []
    const client = new McpClient(hangingSpawn(written).spawn)
    try {
      await client.connect({ command: 'fake' })
      const stop = new AbortController()
      stop.abort()
      const outcome = await settlesWithin(client.callTool('slow', {}, stop.signal), 1_000)
      expect(outcome.settled).toBe(true)
      expect(outcome.error).toBeInstanceOf(Error)
      expect(written.some((m) => m.method === 'tools/call')).toBe(false)
      expect(cancels(written)).toEqual([])
    } finally {
      client.close()
    }
  })

  it('cancels a hung resources/read and prompts/get the same way', async () => {
    const written: Array<Record<string, unknown>> = []
    const client = new McpClient(hangingSpawn(written).spawn)
    try {
      await client.connect({ command: 'fake' })
      const stop = new AbortController()
      const read = client.readResource('mem://x', stop.signal)
      const prompt = client.getPrompt('p', {}, stop.signal)
      await new Promise((r) => setTimeout(r, 5))
      stop.abort()
      const [r, p] = await Promise.all([settlesWithin(read, 1_000), settlesWithin(prompt, 1_000)])
      expect(r.settled && p.settled).toBe(true)
      expect(r.error).toBeInstanceOf(Error)
      expect(p.error).toBeInstanceOf(Error)
      const ids = written.filter((m) => m.method === 'resources/read' || m.method === 'prompts/get').map((m) => m.id)
      expect(ids).toHaveLength(2)
      const cancelled = cancels(written).map((m) => (m.params as { requestId: unknown }).requestId)
      expect(cancelled.sort()).toEqual(ids.sort())
    } finally {
      client.close()
    }
  })
})
