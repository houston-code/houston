import { describe, expect, it, vi } from 'vitest'
import {
  ListRefresher,
  PendingRequests,
  MAX_LIST_ITEMS,
  MAX_LIST_PAGES,
  capMcpOutput,
  listAllPages,
  handleServerMessage,
  keepAliveDuring,
  kindOf,
  parseIncoming,
  type McpListKind
} from './protocol'

describe('parseIncoming / kindOf', () => {
  it('classifies responses, requests, and notifications', () => {
    expect(kindOf({ id: 1, result: {} })).toBe('response')
    expect(kindOf({ id: 2, error: { message: 'x' } })).toBe('response')
    expect(kindOf({ id: 3, method: 'ping' })).toBe('request')
    expect(kindOf({ method: 'notifications/progress' })).toBe('notification')
    expect(kindOf({})).toBe('other')
    expect(kindOf({ id: 4 })).toBe('other')
  })

  it('rejects non-object payloads', () => {
    expect(parseIncoming('hi')).toBeNull()
    expect(parseIncoming([1, 2])).toBeNull()
    expect(parseIncoming(null)).toBeNull()
    expect(parseIncoming({ id: 1 })).toEqual({ id: 1 })
  })
})

function hooks(): {
  sent: unknown[]
  changed: McpListKind[]
  touched: Array<number | string>
  h: Parameters<typeof handleServerMessage>[1]
} {
  const sent: unknown[] = []
  const changed: McpListKind[] = []
  const touched: Array<number | string> = []
  return {
    sent,
    changed,
    touched,
    h: {
      send: (p) => sent.push(p),
      onListChanged: (k) => changed.push(k),
      touchProgress: (t) => touched.push(t)
    }
  }
}

describe('handleServerMessage', () => {
  it('answers a server ping with an empty result', () => {
    const { sent, h } = hooks()
    handleServerMessage({ id: 7, method: 'ping' }, h)
    expect(sent).toEqual([{ jsonrpc: '2.0', id: 7, result: {} }])
  })

  it('answers any other server request with method-not-found instead of dropping it', () => {
    const { sent, h } = hooks()
    handleServerMessage({ id: 'e1', method: 'elicitation/create', params: {} }, h)
    expect(sent).toHaveLength(1)
    const reply = sent[0] as { id: string; error: { code: number; message: string } }
    expect(reply.id).toBe('e1')
    expect(reply.error.code).toBe(-32601)
    expect(reply.error.message).toContain('elicitation/create')
  })

  it('routes elicitation/create to the responder and sends its answer', async () => {
    const { sent, h } = hooks()
    const seen: unknown[] = []
    h.onElicit = async (params) => {
      seen.push(params)
      return { action: 'accept', content: { name: 'Ada' } }
    }
    handleServerMessage(
      { id: 9, method: 'elicitation/create', params: { message: 'Who?', requestedSchema: {} } },
      h
    )
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(seen).toEqual([{ message: 'Who?', requestedSchema: {} }])
    expect(sent[0]).toEqual({
      jsonrpc: '2.0',
      id: 9,
      result: { action: 'accept', content: { name: 'Ada' } }
    })
  })

  it('routes a 2025-11-25 form-mode elicitation to the responder', async () => {
    const { sent, h } = hooks()
    h.onElicit = async () => ({ action: 'decline' })
    handleServerMessage({ id: 11, method: 'elicitation/create', params: { mode: 'form', message: 'x' } }, h)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]).toEqual({ jsonrpc: '2.0', id: 11, result: { action: 'decline' } })
  })

  it('refuses URL-mode (or any non-form) elicitation without asking the user', () => {
    for (const mode of ['url', 'other', 42]) {
      const { sent, h } = hooks()
      const responder = vi.fn(async () => ({ action: 'accept' as const }))
      h.onElicit = responder
      handleServerMessage(
        { id: 'u1', method: 'elicitation/create', params: { mode, url: 'https://example.com/auth', message: 'Sign in' } },
        h
      )
      expect(responder).not.toHaveBeenCalled()
      expect(sent).toEqual([
        { jsonrpc: '2.0', id: 'u1', error: { code: -32602, message: 'This client supports only form elicitation' } }
      ])
    }
  })

  it('answers with a cancel when the elicitation responder fails', async () => {
    const { sent, h } = hooks()
    h.onElicit = async () => {
      throw new Error('run cancelled')
    }
    handleServerMessage({ id: 10, method: 'elicitation/create', params: { message: 'x' } }, h)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]).toEqual({ jsonrpc: '2.0', id: 10, result: { action: 'cancel' } })
  })

  it('routes list_changed notifications by kind', () => {
    const { changed, h } = hooks()
    handleServerMessage({ method: 'notifications/tools/list_changed' }, h)
    handleServerMessage({ method: 'notifications/resources/list_changed' }, h)
    handleServerMessage({ method: 'notifications/prompts/list_changed' }, h)
    expect(changed).toEqual(['tools', 'resources', 'prompts'])
  })

  it('touches the pending request named by a progress notification', () => {
    const { touched, h } = hooks()
    handleServerMessage({ method: 'notifications/progress', params: { progressToken: 3, progress: 0.5 } }, h)
    handleServerMessage({ method: 'notifications/progress', params: { progressToken: 'tok' } }, h)
    handleServerMessage({ method: 'notifications/progress', params: {} }, h) // no token: ignored
    expect(touched).toEqual([3, 'tok'])
  })

  it('ignores unknown notifications and replies to nothing', () => {
    const { sent, changed, touched, h } = hooks()
    handleServerMessage({ method: 'notifications/message', params: { level: 'info' } }, h)
    handleServerMessage({ method: 'notifications/cancelled' }, h)
    expect(sent).toEqual([])
    expect(changed).toEqual([])
    expect(touched).toEqual([])
  })
})

describe('PendingRequests', () => {
  it('settles a response by id (result and error)', async () => {
    const p = new PendingRequests()
    const ok = p.wait(1, 'tools/list', 1000)
    const bad = p.wait(2, 'tools/call', 1000)
    p.settle(1, { id: 1, result: { tools: [] } })
    p.settle(2, { id: 2, error: { message: 'nope' } })
    await expect(ok).resolves.toEqual({ tools: [] })
    await expect(bad).rejects.toThrow('nope')
    expect(p.size).toBe(0)
  })

  it('times out on inactivity', async () => {
    vi.useFakeTimers()
    try {
      const p = new PendingRequests()
      const w = p.wait(1, 'tools/call', 100)
      vi.advanceTimersByTime(101)
      await expect(w).rejects.toThrow(/timed out/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('progress touches keep a slow call alive past the inactivity timeout', async () => {
    vi.useFakeTimers()
    try {
      const p = new PendingRequests()
      const w = p.wait(1, 'tools/call', 100)
      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(80) // 400ms total, but never 100ms without progress
        p.touch(1)
      }
      p.settle(1, { id: 1, result: 'done' })
      await expect(w).resolves.toBe('done')
    } finally {
      vi.useRealTimers()
    }
  })

  it('enforces the absolute ceiling no matter how much progress arrives', async () => {
    vi.useFakeTimers()
    try {
      const p = new PendingRequests()
      const w = p.wait(1, 'tools/call', 100, 500)
      for (let i = 0; i < 10; i++) {
        vi.advanceTimersByTime(80)
        p.touch(1)
      }
      await expect(w).rejects.toThrow(/ceiling/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('failAll rejects everything outstanding', async () => {
    const p = new PendingRequests()
    const a = p.wait(1, 'a', 1000)
    const b = p.wait(2, 'b', 1000)
    p.failAll('gone')
    await expect(a).rejects.toThrow('gone')
    await expect(b).rejects.toThrow('gone')
  })

  it('settling twice or touching the unknown is a no-op', async () => {
    const p = new PendingRequests()
    const a = p.wait(1, 'a', 1000)
    p.settle(1, { id: 1, result: 'first' })
    p.settle(1, { id: 1, result: 'second' })
    p.touch(99)
    await expect(a).resolves.toBe('first')
  })
})

describe('ListRefresher', () => {
  it('coalesces a burst for one kind into a single fetch', async () => {
    const calls: McpListKind[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const r = new ListRefresher({
      isClosed: () => false,
      capable: () => true,
      fetch: async (k) => {
        calls.push(k)
        await gate
      }
    })
    r.schedule('tools')
    r.schedule('tools')
    r.schedule('tools')
    release()
    await new Promise((res) => setTimeout(res, 10))
    expect(calls).toEqual(['tools'])
  })

  it('skips kinds the server never declared and skips when closed', async () => {
    const calls: McpListKind[] = []
    const r = new ListRefresher({
      isClosed: () => false,
      capable: (k) => k === 'tools',
      fetch: async (k) => {
        calls.push(k)
      }
    })
    r.schedule('prompts')
    r.schedule('tools')
    await new Promise((res) => setTimeout(res, 10))
    expect(calls).toEqual(['tools'])
  })

  it('a failing fetch does not wedge later refreshes', async () => {
    const calls: McpListKind[] = []
    let fail = true
    const r = new ListRefresher({
      isClosed: () => false,
      capable: () => true,
      fetch: async (k) => {
        calls.push(k)
        if (fail) throw new Error('boom')
      }
    })
    r.schedule('tools')
    await new Promise((res) => setTimeout(res, 10))
    fail = false
    r.schedule('tools')
    await new Promise((res) => setTimeout(res, 10))
    expect(calls).toEqual(['tools', 'tools'])
  })
})

describe('keepAliveDuring', () => {
  it('keeps every pending call alive while an elicitation dialog is open', async () => {
    vi.useFakeTimers()
    try {
      const p = new PendingRequests()
      // Attach the rejection handler up front: the timeout fires inside a timer
      // advance, and an unhandled rejection there would flag the whole run.
      const callOutcome = p.wait(1, 'tools/call', 100).catch((e: Error) => e.message)
      let resolveUser: (v: string) => void = () => {}
      const work = keepAliveDuring(p, () => new Promise<string>((r) => (resolveUser = r)), 60)
      // Far past the call's inactivity timeout: the keep-alive interval must have
      // been restarting its clock the whole time.
      await vi.advanceTimersByTimeAsync(500)
      expect(p.has(1)).toBe(true)
      resolveUser('done')
      await expect(work).resolves.toBe('done')
      // With the dialog closed the inactivity clock runs down normally again.
      await vi.advanceTimersByTimeAsync(101)
      expect(await callOutcome).toMatch(/timed out/)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('capMcpOutput', () => {
  it('passes short output through untouched', () => {
    expect(capMcpOutput('hello')).toBe('hello')
  })

  it('truncates oversized output and says how big it was', () => {
    const big = 'x'.repeat(60_000)
    const capped = capMcpOutput(big, 50_000)
    expect(capped.length).toBeLessThan(51_000)
    expect(capped).toContain('[truncated: the MCP server returned 60000 chars]')
  })
})

describe('listAllPages', () => {
  /** A server whose pages are `pages`, linked by cursors `c1`, `c2`, ... */
  function paged(pages: unknown[][], key = 'tools'): {
    fetch: (params: Record<string, unknown>) => Promise<unknown>
    params: Array<Record<string, unknown>>
  } {
    const params: Array<Record<string, unknown>> = []
    const fetch = async (p: Record<string, unknown>): Promise<unknown> => {
      params.push(p)
      const i = p.cursor === undefined ? 0 : Number(String(p.cursor).slice(1))
      return { [key]: pages[i], ...(i + 1 < pages.length ? { nextCursor: `c${i + 1}` } : {}) }
    }
    return { fetch, params }
  }

  it('returns a single page as is, asking without a cursor', async () => {
    const { fetch, params } = paged([[{ name: 'a' }]])
    expect(await listAllPages(fetch, 'tools')).toEqual({ tools: [{ name: 'a' }] })
    expect(params).toEqual([{}])
  })

  it('follows nextCursor and merges every page, in order', async () => {
    const { fetch, params } = paged([[{ uri: 'a' }], [{ uri: 'b' }, { uri: 'c' }], [{ uri: 'd' }]], 'resources')
    expect(await listAllPages(fetch, 'resources')).toEqual({
      resources: [{ uri: 'a' }, { uri: 'b' }, { uri: 'c' }, { uri: 'd' }]
    })
    expect(params).toEqual([{}, { cursor: 'c1' }, { cursor: 'c2' }])
  })

  it('treats an empty or null nextCursor as the last page', async () => {
    for (const nextCursor of ['', null]) {
      const fetch = vi.fn(async () => ({ prompts: [{ name: 'p' }], nextCursor }))
      expect(await listAllPages(fetch, 'prompts')).toEqual({ prompts: [{ name: 'p' }] })
      expect(fetch).toHaveBeenCalledTimes(1)
    }
  })

  it('omits the key when the first page has no array (callers keep their old list)', async () => {
    expect(await listAllPages(async () => ({}), 'tools')).toEqual({})
    expect(await listAllPages(async () => null, 'tools')).toEqual({})
    expect(await listAllPages(async () => ({ tools: 'nope' }), 'tools')).toEqual({})
  })

  it('keeps what it has when a later page has no array', async () => {
    let n = 0
    const fetch = async (): Promise<unknown> => (n++ === 0 ? { tools: [{ name: 'a' }], nextCursor: 'x' } : {})
    expect(await listAllPages(fetch, 'tools')).toEqual({ tools: [{ name: 'a' }] })
  })

  it('stops on a repeated cursor instead of looping forever', async () => {
    const fetch = vi.fn(async () => ({ tools: [{ name: 'a' }], nextCursor: 'same' }))
    const out = await listAllPages(fetch, 'tools')
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(out.tools).toHaveLength(2)
    expect(out.truncated).toMatch(/repeated a page cursor/)
  })

  it('stops on a cursor that is not a short string', async () => {
    for (const nextCursor of [42, { a: 1 }, 'x'.repeat(5000)]) {
      const fetch = vi.fn(async () => ({ tools: [{ name: 'a' }], nextCursor }))
      const out = await listAllPages(fetch, 'tools')
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(out).toEqual({ tools: [{ name: 'a' }], truncated: expect.stringMatching(/malformed page cursor/) })
    }
  })

  it(`reads at most ${MAX_LIST_PAGES} pages`, async () => {
    let n = 0
    const fetch = vi.fn(async () => ({ tools: [{ name: `t${n}` }], nextCursor: `c${++n}` }))
    const out = await listAllPages(fetch, 'tools')
    expect(fetch).toHaveBeenCalledTimes(MAX_LIST_PAGES)
    expect(out.tools).toHaveLength(MAX_LIST_PAGES)
    expect(out.truncated).toBe(`only the first ${MAX_LIST_PAGES} pages were read`)
  })

  it(`keeps at most ${MAX_LIST_ITEMS} entries across pages`, async () => {
    const page = Array.from({ length: 2_000 }, (_, i) => ({ name: `t${i}` }))
    let n = 0
    const fetch = vi.fn(async () => ({ tools: page, nextCursor: `c${++n}` }))
    const out = await listAllPages(fetch, 'tools')
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(out.tools).toHaveLength(MAX_LIST_ITEMS)
    expect(out.truncated).toBe(`the list was cut at ${MAX_LIST_ITEMS} entries`)
  })

  it('fails the walk when any page fails', async () => {
    let n = 0
    const fetch = async (): Promise<unknown> => {
      if (n++ === 0) return { tools: [{ name: 'a' }], nextCursor: 'x' }
      throw new Error('MCP tools/list timed out')
    }
    await expect(listAllPages(fetch, 'tools')).rejects.toThrow('timed out')
  })
})
