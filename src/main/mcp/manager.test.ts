import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { McpServerConfig } from '@shared/types'
import { mcpHeaderScope } from '@shared/types'
import { mcpToolName } from '@shared/mcp'
import { McpClient, type SpawnFn } from './client'
import { McpHttpClient, type FetchFn } from './http-client'
import { McpSseClient, type SseConnectFn, type SseEvent } from './sse-client'

// The manager resolves each server's secret headers through the agent host. Back it
// with a mutable map so a test can rotate a stored header value and assert the change
// is seen — the masked config the manager receives never carries the real value.
const host = vi.hoisted(() => ({ headers: {} as Record<string, Record<string, string>> }))
vi.mock('../agentHost', () => ({
  getSecretHeaders: (scope: string) => host.headers[scope] ?? {}
}))

import {
  _setMcpClientFactory,
  _setMcpHttpClientFactory,
  _setMcpSseClientFactory,
  disconnectAllMcp,
  getMcpToolDefs
} from './manager'

/** A fake stdio server exposing one tool — a fresh child per spawn call. */
function okSpawn(toolName = 'echo'): SpawnFn {
  return (() => {
    const stdout = new EventEmitter()
    const stdin = {
      write(line: string): boolean {
        const msg = JSON.parse(line.trim()) as { id?: number; method: string }
        if (msg.id === undefined) return true
        const result = msg.method === 'tools/list' ? { tools: [{ name: toolName }] } : {}
        queueMicrotask(() =>
          stdout.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`))
        )
        return true
      }
    }
    return Object.assign(new EventEmitter(), { stdout, stdin, stderr: new EventEmitter(), kill: () => {} })
  }) as unknown as SpawnFn
}

/** A spawn whose process errors right after start, so connect() rejects fast. The
 * child is created per call (inside connect), so the error fires after connect's
 * 'error' listener is attached. */
function failingSpawn(): SpawnFn {
  return (() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stdin: { write: () => true },
      stderr: new EventEmitter(),
      kill: () => {}
    })
    queueMicrotask(() => child.emit('error', new Error('boom')))
    return child
  }) as unknown as SpawnFn
}

let created: McpClient[] = []
function useFactory(spawn: SpawnFn): void {
  created = []
  _setMcpClientFactory(() => {
    const c = new McpClient(spawn)
    created.push(c)
    return c
  })
}

const cfg = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({
  id: 'srv',
  name: 'Srv',
  command: 'fake',
  args: [],
  enabled: true,
  ...over
})

/** A fake HTTP MCP server exposing one tool. */
function okHttpFetch(toolName = 'remote'): FetchFn {
  return async (_url, init) => {
    const req = JSON.parse(init.body as string) as { id?: number; method: string }
    const result = req.method === 'tools/list' ? { tools: [{ name: toolName }] } : {}
    const body = req.id === undefined ? '' : JSON.stringify({ jsonrpc: '2.0', id: req.id, result })
    return new Response(body, { status: 200, headers: new Headers({ 'content-type': 'application/json' }) })
  }
}

/** A fake SSE MCP server exposing one tool, answering POSTs over the stream. */
function okSseClient(toolName = 'streamed'): McpSseClient {
  let emit: ((e: SseEvent) => void) | null = null
  const connect: SseConnectFn = (_url, _headers, handlers) => {
    emit = handlers.onEvent
    queueMicrotask(() => emit?.({ event: 'endpoint', data: '/messages' }))
    return { close: () => {} }
  }
  const fetch: FetchFn = async (_url, init) => {
    const req = JSON.parse(init.body as string) as { id?: number; method: string }
    if (req.id !== undefined) {
      const result = req.method === 'tools/list' ? { tools: [{ name: toolName }] } : {}
      queueMicrotask(() => emit?.({ event: 'message', data: JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) }))
    }
    return new Response('', { status: 202 })
  }
  return new McpSseClient(connect, fetch)
}

afterEach(() => {
  disconnectAllMcp()
  _setMcpClientFactory(null)
  _setMcpHttpClientFactory(null)
  _setMcpSseClientFactory(null)
  host.headers = {}
})

describe('mcp manager', () => {
  it('namespaces each server tool as mcp__<id>__<tool>', async () => {
    useFactory(okSpawn('echo'))
    const defs = await getMcpToolDefs([cfg()])
    expect(defs.map((d) => d.schema.name)).toEqual([mcpToolName('srv', 'echo')])
    expect(defs[0].kind).toBe('mcp')
  })

  it('reuses an unchanged connection across calls (no reconnect)', async () => {
    useFactory(okSpawn())
    await getMcpToolDefs([cfg()])
    await getMcpToolDefs([cfg()])
    expect(created).toHaveLength(1)
    expect(created[0].isClosed).toBe(false)
  })

  it('reconnects when the config changes, closing the old client', async () => {
    useFactory(okSpawn())
    await getMcpToolDefs([cfg()])
    await getMcpToolDefs([cfg({ args: ['--flag'] })])
    expect(created).toHaveLength(2)
    expect(created[0].isClosed).toBe(true)
    expect(created[1].isClosed).toBe(false)
  })

  it('reconnects when a stored header value changes (the masked config is unchanged)', async () => {
    useFactory(okSpawn())
    await getMcpToolDefs([cfg()])
    expect(created).toHaveLength(1)
    // Rotate the secret behind the same (masked) config — the manager must notice via
    // the resolved headers, not the config object, and reconnect.
    host.headers[mcpHeaderScope('srv')] = { Authorization: 'Bearer rotated' }
    await getMcpToolDefs([cfg()])
    expect(created).toHaveLength(2)
    expect(created[0].isClosed).toBe(true)
  })

  it('closes and drops a server that is removed', async () => {
    useFactory(okSpawn())
    await getMcpToolDefs([cfg()])
    const defs = await getMcpToolDefs([])
    expect(defs).toEqual([])
    expect(created[0].isClosed).toBe(true)
  })

  it('skips a server that fails to connect (no throw, no tools)', async () => {
    useFactory(failingSpawn())
    const defs = await getMcpToolDefs([cfg()])
    expect(defs).toEqual([])
  })

  it('returns [] when no servers are configured', async () => {
    expect(await getMcpToolDefs(undefined)).toEqual([])
    expect(await getMcpToolDefs([])).toEqual([])
  })

  it('connects an HTTP server (transport: http) and namespaces its tools', async () => {
    _setMcpHttpClientFactory(() => new McpHttpClient(okHttpFetch('remote')))
    const defs = await getMcpToolDefs([
      cfg({ id: 'web', transport: 'http', command: '', url: 'https://x/mcp' })
    ])
    expect(defs.map((d) => d.schema.name)).toEqual([mcpToolName('web', 'remote')])
  })

  it('infers the HTTP transport from a url when no command is set', async () => {
    _setMcpHttpClientFactory(() => new McpHttpClient(okHttpFetch()))
    const defs = await getMcpToolDefs([cfg({ id: 'web', command: '', url: 'https://x/mcp' })])
    expect(defs).toHaveLength(1)
    expect(defs[0].schema.name).toBe(mcpToolName('web', 'remote'))
  })

  it('connects an SSE server (transport: sse) and namespaces its tools', async () => {
    _setMcpSseClientFactory(() => okSseClient('streamed'))
    const defs = await getMcpToolDefs([
      cfg({ id: 'live', transport: 'sse', command: '', url: 'https://x/sse' })
    ])
    expect(defs.map((d) => d.schema.name)).toEqual([mcpToolName('live', 'streamed')])
  })
})
