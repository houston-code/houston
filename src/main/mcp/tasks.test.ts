import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { McpRpcError } from './protocol'
import { McpHttpClient, type FetchFn } from './http-client'
import { MAX_TASK_MS, TASKS_EXTENSION, followTask, pollDelayMs, statusLine } from './tasks'
import { clientCapabilities } from './stateless'

/** Settle `p` while advancing fake timers. */
async function settle<T>(p: Promise<T>): Promise<T> {
  let done = false
  const out = p.finally(() => (done = true))
  // Handled here too, so a rejection before the caller awaits is not reported as unhandled.
  out.catch(() => {})
  for (let i = 0; i < 500 && !done; i++) await vi.advanceTimersByTimeAsync(300)
  return out
}

describe('followTask', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  })
  afterEach(() => vi.useRealTimers())

  /** A server whose tasks/get answers come from `states`, in order; records every request. */
  function server(states: unknown[]): { request: (m: string, p: Record<string, unknown>) => Promise<unknown>; calls: Array<[string, Record<string, unknown>]> } {
    const calls: Array<[string, Record<string, unknown>]> = []
    return {
      calls,
      request: async (method, params) => {
        calls.push([method, params])
        if (method === 'tasks/get') return states.shift()
        return { resultType: 'complete' }
      }
    }
  }
  const created = { resultType: 'task', taskId: 't1', status: 'working', pollIntervalMs: 500, statusMessage: 'Queued' }

  it('polls until the task completes and returns its result, reporting each new status', async () => {
    const s = server([
      { status: 'working', statusMessage: 'Queued' },
      { status: 'working', statusMessage: 'Building\n3 of 10' },
      { status: 'completed', result: { content: [{ type: 'text', text: 'done' }] } }
    ])
    const statuses: string[] = []
    const out = await settle(followTask(created, 'tools/call', { request: s.request, onStatus: (m) => statuses.push(m) }))
    expect(out).toEqual({ content: [{ type: 'text', text: 'done' }] })
    expect(statuses).toEqual(['Queued', 'Building 3 of 10'])
    expect(s.calls.map(([m]) => m)).toEqual(['tasks/get', 'tasks/get', 'tasks/get'])
    expect(s.calls[0][1]).toEqual({ taskId: 't1' })
  })

  it('throws the server\'s error for a failed task', async () => {
    const s = server([{ status: 'failed', error: { code: -32603, message: 'build broke' } }])
    const err = await settle(followTask(created, 'tools/call', { request: s.request })).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(McpRpcError)
    expect(err).toMatchObject({ message: 'build broke', code: -32603 })
  })

  it('throws for a task the server cancelled, and for an unknown status', async () => {
    await expect(settle(followTask(created, 'tools/call', { request: server([{ status: 'cancelled' }]).request }))).rejects.toThrow(
      'cancelled by the server'
    )
    await expect(settle(followTask(created, 'tools/call', { request: server([{ status: 'odd' }]).request }))).rejects.toThrow(
      'unknown status'
    )
  })

  it('answers input_required through the responder and tasks/update, then keeps polling', async () => {
    const s = server([
      {
        status: 'input_required',
        inputRequests: { ok: { method: 'elicitation/create', params: { mode: 'form', message: 'Deploy?' } } }
      },
      { status: 'completed', result: { content: [] } }
    ])
    const onElicit = vi.fn(async () => ({ action: 'accept' as const, content: { yes: true } }))
    await settle(followTask(created, 'tools/call', { request: s.request, onElicit }))
    expect(onElicit).toHaveBeenCalledWith({ mode: 'form', message: 'Deploy?' })
    expect(s.calls[1]).toEqual(['tasks/update', { taskId: 't1', inputResponses: { ok: { action: 'accept', content: { yes: true } } } }])
  })

  it('cancels the task when it asks for something Houston does not offer', async () => {
    const s = server([{ status: 'input_required', inputRequests: { s: { method: 'sampling/createMessage', params: {} } } }])
    await expect(
      settle(followTask(created, 'tools/call', { request: s.request, onElicit: async () => ({ action: 'accept' }) }))
    ).rejects.toThrow('which Houston does not offer')
    expect(s.calls.map(([m]) => m)).toContain('tasks/cancel')
  })

  it('cancels the task on Stop', async () => {
    const s = server([{ status: 'working' }, { status: 'working' }, { status: 'working' }])
    const stop = new AbortController()
    const run = followTask(created, 'tools/call', { request: s.request, signal: stop.signal })
    const caught = run.catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(600)
    stop.abort()
    await vi.advanceTimersByTimeAsync(10)
    expect(String(await caught)).toContain('cancelled')
    expect(s.calls.at(-1)).toEqual(['tasks/cancel', { taskId: 't1' }])
  })

  it(`stops following a task after ${MAX_TASK_MS / 60_000} minutes, and cancels it`, async () => {
    let t = 0
    const s = server(Array.from({ length: 10 }, () => ({ status: 'working' })))
    const out = settle(
      followTask({ ...created, pollIntervalMs: 30_000 }, 'tools/call', { request: s.request, now: () => (t += MAX_TASK_MS / 3) })
    )
    await expect(out).rejects.toThrow('Houston stopped following it')
    expect(s.calls.at(-1)?.[0]).toBe('tasks/cancel')
  })

  it('requires a task id', async () => {
    await expect(followTask({ resultType: 'task' }, 'tools/call', { request: async () => ({}) })).rejects.toThrow('without an id')
  })
})

describe('task helpers', () => {
  it('clamps the poll interval', () => {
    expect(pollDelayMs(undefined)).toBe(1_000)
    expect(pollDelayMs(1)).toBe(250)
    expect(pollDelayMs(10 * 60_000)).toBe(30_000)
    expect(pollDelayMs(2_000)).toBe(2_000)
  })

  it('flattens and caps a status message', () => {
    expect(statusLine('a\u0007b\nc')).toBe('a b c')
    expect(statusLine('x'.repeat(500)).length).toBe(200)
    expect(statusLine(42)).toBe('')
  })

  it('declares the extension in each request\'s capabilities', () => {
    expect(clientCapabilities({ elicitation: false, tasks: true })).toEqual({ extensions: { [TASKS_EXTENSION]: {} } })
    expect(clientCapabilities({ elicitation: false })).toEqual({})
  })
})

describe('a 2026-07-28 HTTP server that runs a call as a task', () => {
  it('follows the task to its result, shows its status, and declares the extension', async () => {
    const seen: Array<{ method?: string; params?: Record<string, unknown> }> = []
    let polls = 0
    const fetch: FetchFn = async (_u, init) => {
      if (init.method === 'GET') return new Response('', { status: 405 })
      const msg = JSON.parse(init.body as string) as { id?: number; method?: string; params?: Record<string, unknown> }
      seen.push(msg)
      let result: unknown = { resultType: 'complete' }
      if (msg.method === 'server/discover') {
        result = {
          resultType: 'complete',
          supportedVersions: ['2026-07-28'],
          capabilities: { tools: {}, extensions: { [TASKS_EXTENSION]: {} } }
        }
      } else if (msg.method === 'tools/list') result = { resultType: 'complete', tools: [{ name: 'deploy' }] }
      else if (msg.method === 'tools/call') {
        result = { resultType: 'task', taskId: 'job-9', status: 'working', ttlMs: null, pollIntervalMs: 250, createdAt: '', lastUpdatedAt: '' }
      } else if (msg.method === 'tasks/get') {
        polls++
        result =
          polls < 2
            ? { resultType: 'complete', taskId: 'job-9', status: 'working', statusMessage: 'Uploading' }
            : { resultType: 'complete', taskId: 'job-9', status: 'completed', result: { content: [{ type: 'text', text: 'deployed' }] } }
      } else if (msg.method === 'subscriptions/listen') return new Response('', { status: 405 })
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }), {
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' })
      })
    }
    const client = new McpHttpClient(fetch)
    await client.connect({ url: 'https://x.test/mcp' })
    const statuses: string[] = []
    expect(await client.callTool('deploy', {}, undefined, undefined, (m) => statuses.push(m))).toBe('deployed')
    expect(statuses).toEqual(['Uploading'])
    const call = seen.find((m) => m.method === 'tools/call')!
    expect((call.params?._meta as Record<string, unknown>)['io.modelcontextprotocol/clientCapabilities']).toEqual({
      extensions: { [TASKS_EXTENSION]: {} }
    })
    expect(seen.filter((m) => m.method === 'tasks/get').every((m) => m.params?.taskId === 'job-9')).toBe(true)
    client.close()
  })
})
