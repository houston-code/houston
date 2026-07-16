import { describe, expect, it, vi } from 'vitest'
import {
  ListRefresher,
  PendingRequests,
  capMcpOutput,
  handleServerMessage,
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
