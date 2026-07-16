import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { McpServerConfig } from '@shared/types'
import { mcpEnvScope, mcpHeaderScope } from '@shared/types'
import { mcpToolName } from '@shared/mcp'
import { McpClient, type SpawnFn } from './client'
import { McpHttpClient, type FetchFn } from './http-client'
import { McpSseClient, type SseConnectFn, type SseEvent } from './sse-client'
import type { McpOAuthTokens } from './oauth'
import type { ToolContext } from '../agent/tools'

// The manager resolves each server's secret headers and OAuth tokens through the
// agent host. Back them with mutable maps so a test can rotate a stored header value
// or token set and assert the change is seen — the masked config the manager
// receives never carries the real value.
const host = vi.hoisted(() => ({
  headers: {} as Record<string, Record<string, string>>,
  oauth: {} as Record<string, McpOAuthTokens>
}))
vi.mock('../agentHost', () => ({
  getSecretHeaders: (scope: string) => host.headers[scope] ?? {},
  getMcpOAuth: (serverId: string) => host.oauth[serverId] ?? null,
  setMcpOAuth: (serverId: string, tokens: McpOAuthTokens | null) => {
    if (tokens) host.oauth[serverId] = tokens
    else delete host.oauth[serverId]
  }
}))

// Refresh control: tests flip `refreshResult` to observe proactive/reactive refresh
// without real token-endpoint traffic.
const oauthSeam = vi.hoisted(() => ({
  refreshResult: null as McpOAuthTokens | null,
  refreshCalls: 0
}))
vi.mock('./oauth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./oauth')>()),
  refreshMcpOAuth: async (tokens: McpOAuthTokens) => {
    oauthSeam.refreshCalls += 1
    if (!oauthSeam.refreshResult) throw new Error('refresh rejected')
    return { ...tokens, ...oauthSeam.refreshResult }
  }
}))

import {
  _setMcpClientFactory,
  _setMcpHttpClientFactory,
  _setMcpSseClientFactory,
  disconnectAllMcp,
  getMcpStatuses,
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

/** A fake stdio server that declares the resources capability and exposes one resource. */
function resourcefulSpawn(): SpawnFn {
  return (() => {
    const stdout = new EventEmitter()
    const stdin = {
      write(line: string): boolean {
        const msg = JSON.parse(line.trim()) as { id?: number; method: string }
        if (msg.id === undefined) return true
        let result: unknown = {}
        if (msg.method === 'initialize') result = { capabilities: { resources: {} } }
        else if (msg.method === 'tools/list') result = { tools: [{ name: 'echo' }] }
        else if (msg.method === 'resources/list') result = { resources: [{ uri: 'mem://note', name: 'Note' }] }
        else if (msg.method === 'resources/read') result = { contents: [{ uri: 'mem://note', text: 'the note body' }] }
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
  host.oauth = {}
  oauthSeam.refreshResult = null
  oauthSeam.refreshCalls = 0
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

  const noCtx = { workspace: '/tmp', allowNetwork: false } as ToolContext

  it('adds resource meta-tools and reads a resource when a server exposes resources', async () => {
    useFactory(resourcefulSpawn())
    const defs = await getMcpToolDefs([cfg()])
    const names = defs.map((d) => d.schema.name)
    expect(names).toContain('mcp_list_resources')
    expect(names).toContain('mcp_read_resource')
    expect(defs.find((d) => d.schema.name === 'mcp_list_resources')!.kind).toBe('read')
    expect(defs.find((d) => d.schema.name === 'mcp_read_resource')!.kind).toBe('mcp')

    const list = await defs.find((d) => d.schema.name === 'mcp_list_resources')!.execute({}, noCtx)
    expect(list).toContain('mem://note')
    const read = await defs
      .find((d) => d.schema.name === 'mcp_read_resource')!
      .execute({ server: 'srv', uri: 'mem://note' }, noCtx)
    expect(read).toBe('the note body')
  })

  it('omits resource meta-tools when no server exposes resources', async () => {
    useFactory(okSpawn())
    const defs = await getMcpToolDefs([cfg()])
    const names = defs.map((d) => d.schema.name)
    expect(names).not.toContain('mcp_list_resources')
    expect(names).not.toContain('mcp_read_resource')
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

/** An HTTP fake that 401s unless the request carries `Bearer <accepted>`. */
function authHttpFetch(accepted: string): { fetch: FetchFn; auths: Array<string | undefined> } {
  const auths: Array<string | undefined> = []
  const fetch: FetchFn = async (_url, init) => {
    const headers = init.headers as Record<string, string>
    const auth = headers.authorization ?? headers.Authorization
    auths.push(auth)
    if (auth !== `Bearer ${accepted}`) {
      return new Response('', { status: 401, headers: new Headers({ 'www-authenticate': 'Bearer' }) })
    }
    const req = JSON.parse(init.body as string) as { id?: number; method: string }
    const result = req.method === 'tools/list' ? { tools: [{ name: 'remote' }] } : {}
    const body = req.id === undefined ? '' : JSON.stringify({ jsonrpc: '2.0', id: req.id, result })
    return new Response(body, { status: 200, headers: new Headers({ 'content-type': 'application/json' }) })
  }
  return { fetch, auths }
}

const tok = (over: Partial<McpOAuthTokens> = {}): McpOAuthTokens => ({
  access: 'live-token',
  refresh: 'refresh-1',
  clientId: 'cid',
  tokenEndpoint: 'https://as/token',
  ...over
})

const webCfg = (): McpServerConfig => cfg({ id: 'web', transport: 'http', command: '', url: 'https://x/mcp' })

describe('mcp manager OAuth', () => {
  it('sends the stored bearer on connect', async () => {
    host.oauth.web = tok()
    const { fetch, auths } = authHttpFetch('live-token')
    _setMcpHttpClientFactory(() => new McpHttpClient(fetch))
    const defs = await getMcpToolDefs([webCfg()])
    expect(defs.map((d) => d.schema.name)).toEqual([mcpToolName('web', 'remote')])
    expect(auths[0]).toBe('Bearer live-token')
    expect(oauthSeam.refreshCalls).toBe(0)
  })

  it("prefers the user's explicit Authorization header over stored OAuth tokens", async () => {
    host.headers[mcpHeaderScope('web')] = { Authorization: 'Bearer static-token' }
    host.oauth.web = tok()
    const { fetch, auths } = authHttpFetch('static-token')
    _setMcpHttpClientFactory(() => new McpHttpClient(fetch))
    const defs = await getMcpToolDefs([webCfg()])
    expect(defs).toHaveLength(1)
    expect(auths.every((a) => a === 'Bearer static-token')).toBe(true)
    expect(oauthSeam.refreshCalls).toBe(0)
  })

  it('proactively refreshes an expired access token and persists the new set', async () => {
    host.oauth.web = tok({ access: 'stale-token', expiresAt: Date.now() - 1 })
    oauthSeam.refreshResult = tok({ access: 'live-token', expiresAt: Date.now() + 3_600_000 })
    const { fetch, auths } = authHttpFetch('live-token')
    _setMcpHttpClientFactory(() => new McpHttpClient(fetch))
    const defs = await getMcpToolDefs([webCfg()])
    expect(defs).toHaveLength(1)
    expect(oauthSeam.refreshCalls).toBe(1)
    expect(auths[0]).toBe('Bearer live-token')
    expect(host.oauth.web.access).toBe('live-token') // re-persisted through the host
  })

  it('retries once with a forced refresh when a non-expired token gets a 401', async () => {
    // No expiresAt: the manager can't see it's stale, so the server's 401 is the signal.
    host.oauth.web = tok({ access: 'revoked-token' })
    oauthSeam.refreshResult = tok({ access: 'live-token' })
    const { fetch, auths } = authHttpFetch('live-token')
    _setMcpHttpClientFactory(() => new McpHttpClient(fetch))
    const defs = await getMcpToolDefs([webCfg()])
    expect(defs).toHaveLength(1)
    expect(oauthSeam.refreshCalls).toBe(1)
    expect(auths[0]).toBe('Bearer revoked-token')
    expect(auths.at(-1)).toBe('Bearer live-token')
  })

  it('refuses to send tokens bound to a different resource (URL repoint)', async () => {
    // Minted for original.example, but the config now points elsewhere: the bearer
    // must not follow the URL edit to the new host.
    host.oauth.web = tok({ resource: 'https://original.example/mcp' })
    const { fetch, auths } = authHttpFetch('live-token')
    _setMcpHttpClientFactory(() => new McpHttpClient(fetch))
    expect(await getMcpToolDefs([webCfg()])).toEqual([])
    expect(auths.length).toBeGreaterThan(0)
    expect(auths.every((a) => a === undefined)).toBe(true)
    expect(oauthSeam.refreshCalls).toBe(0)
  })

  it('sends tokens whose recorded binding matches the configured URL', async () => {
    host.oauth.web = tok({ resource: 'https://x/mcp' })
    const { fetch, auths } = authHttpFetch('live-token')
    _setMcpHttpClientFactory(() => new McpHttpClient(fetch))
    expect(await getMcpToolDefs([webCfg()])).toHaveLength(1)
    expect(auths[0]).toBe('Bearer live-token')
  })

  it('skips the server (no throw) when a 401 arrives and no tokens are stored', async () => {
    const { fetch } = authHttpFetch('never-matches')
    _setMcpHttpClientFactory(() => new McpHttpClient(fetch))
    expect(await getMcpToolDefs([webCfg()])).toEqual([])
    expect(oauthSeam.refreshCalls).toBe(0)
  })

  it('reconnects with fresh credentials after a sign-in (token appears)', async () => {
    const { fetch } = authHttpFetch('live-token')
    _setMcpHttpClientFactory(() => new McpHttpClient(fetch))
    expect(await getMcpToolDefs([webCfg()])).toEqual([])
    host.oauth.web = tok() // user signed in between runs
    expect((await getMcpToolDefs([webCfg()])).map((d) => d.schema.name)).toEqual([
      mcpToolName('web', 'remote')
    ])
  })
})

describe('mcp manager statuses and hardening', () => {
  const noCtx = { workspace: '/tmp', allowNetwork: false } as ToolContext

  it('reports connected / needs-auth / error statuses per server', async () => {
    useFactory(okSpawn())
    const { fetch } = authHttpFetch('never-matches')
    _setMcpHttpClientFactory(() => new McpHttpClient(fetch))
    await getMcpToolDefs([
      cfg({ id: 'good' }),
      cfg({ id: 'auth', transport: 'http', command: '', url: 'https://x/mcp' })
    ])
    const byId = Object.fromEntries(getMcpStatuses().map((s) => [s.id, s]))
    expect(byId.good.state).toBe('connected')
    expect(byId.good.tools).toBe(1)
    expect(byId.auth.state).toBe('needs-auth')
    // Statuses for removed servers disappear on the next reconcile.
    await getMcpToolDefs([cfg({ id: 'good' })])
    expect(getMcpStatuses().map((s) => s.id)).toEqual(['good'])
  })

  it('passes resolved env and cwd to the stdio client and reconnects when they change', async () => {
    const captured: Array<{ env?: NodeJS.ProcessEnv; cwd?: string }> = []
    created = []
    _setMcpClientFactory(() => {
      const c = new McpClient(((_cmd: string, _args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string }) => {
        captured.push(options)
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
        return Object.assign(new EventEmitter(), { stdout, stdin, stderr: new EventEmitter(), kill: () => {} })
      }) as unknown as SpawnFn)
      created.push(c)
      return c
    })
    host.headers[mcpEnvScope('srv')] = { MY_TOKEN: 'tok-1' }
    await getMcpToolDefs([cfg({ cwd: '/srv/dir' })])
    expect(captured[0].cwd).toBe('/srv/dir')
    expect(captured[0].env?.MY_TOKEN).toBe('tok-1')

    // Rotating the stored env value must trigger a reconnect (like headers).
    host.headers[mcpEnvScope('srv')] = { MY_TOKEN: 'tok-2' }
    await getMcpToolDefs([cfg({ cwd: '/srv/dir' })])
    expect(captured).toHaveLength(2)
    expect(captured[1].env?.MY_TOKEN).toBe('tok-2')
  })

  it('caps oversized tool output before it reaches the agent', async () => {
    _setMcpHttpClientFactory(
      () =>
        new McpHttpClient(async (_url, init) => {
          if (init.method === 'GET') return new Response('', { status: 405 })
          const req = JSON.parse(init.body as string) as { id?: number; method: string }
          if (req.id === undefined) return new Response('', { status: 202 })
          const result =
            req.method === 'tools/list'
              ? { tools: [{ name: 'flood' }] }
              : req.method === 'tools/call'
                ? { content: [{ type: 'text', text: 'x'.repeat(60_000) }] }
                : {}
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }), {
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' })
          })
        })
    )
    const defs = await getMcpToolDefs([cfg({ id: 'web', transport: 'http', command: '', url: 'https://x/mcp' })])
    const out = (await defs[0].execute({}, noCtx)) as string
    expect(out.length).toBeLessThan(51_000)
    expect(out).toContain('[truncated')
  })

  it('exposes prompt meta-tools when a server has prompts, and fetches one', async () => {
    _setMcpHttpClientFactory(
      () =>
        new McpHttpClient(async (_url, init) => {
          if (init.method === 'GET') return new Response('', { status: 405 })
          const req = JSON.parse(init.body as string) as { id?: number; method: string }
          if (req.id === undefined) return new Response('', { status: 202 })
          let result: unknown = {}
          if (req.method === 'initialize') result = { capabilities: { prompts: {} } }
          else if (req.method === 'tools/list') result = { tools: [] }
          else if (req.method === 'prompts/list') result = { prompts: [{ name: 'review' }] }
          else if (req.method === 'prompts/get')
            result = { messages: [{ role: 'user', content: [{ type: 'text', text: 'do a review' }] }] }
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }), {
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' })
          })
        })
    )
    const defs = await getMcpToolDefs([cfg({ id: 'web', transport: 'http', command: '', url: 'https://x/mcp' })])
    const names = defs.map((d) => d.schema.name)
    expect(names).toContain('mcp_list_prompts')
    expect(names).toContain('mcp_get_prompt')
    const list = (await defs.find((d) => d.schema.name === 'mcp_list_prompts')!.execute({}, noCtx)) as string
    expect(list).toContain('review')
    const got = (await defs
      .find((d) => d.schema.name === 'mcp_get_prompt')!
      .execute({ server: 'web', name: 'review' }, noCtx)) as string
    expect(got).toBe('user: do a review')
  })

  it('reconnects a dead connection mid-run and tells the agent to retry', async () => {
    useFactory(okSpawn())
    const defs = await getMcpToolDefs([cfg()])
    expect(created).toHaveLength(1)
    // Kill the live connection out from under the run.
    created[0].close()
    const out = (await defs[0].execute({}, noCtx)) as string
    expect(out).toContain('connection was lost mid-call')
    expect(out).toContain('retry')
    // The reconcile inside the failed call already brought up a replacement.
    expect(created).toHaveLength(2)
    expect(created[1].isClosed).toBe(false)
  })
})
