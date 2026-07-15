import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, Provider } from '@shared/agent'
import { COMPACTION_SUMMARY_PREFIX, estimateTokens } from './compaction'

// Hoisted holders the mocks read, so each test can swap conversation/provider.
const h = vi.hoisted(() => ({
  conv: null as { id: string; workspace: string; messages: ChatMessage[] } | null,
  saved: null as ChatMessage[] | null,
  // Arguments of every setCompaction call, so tests can assert the stored
  // loop-compaction state was cleared when (and only when) the log is rewritten.
  compactionSet: [] as unknown[],
  provider: null as Provider | null
}))

vi.mock('../providers', () => ({ createProvider: () => h.provider }))
vi.mock('../agentHost', () => ({
  getProvider: () => ({ id: 'anthropic', kind: 'anthropic', models: [] })
}))
vi.mock('../conversations', () => ({
  getConversation: () => h.conv,
  setMessages: (_id: string, m: ChatMessage[]) => {
    h.saved = m
  },
  setCompaction: (_id: string, c: unknown) => {
    h.compactionSet.push(c)
  }
}))

const { applyCompaction, compactConversationNow } = await import('./compact')

afterEach(() => {
  h.conv = null
  h.saved = null
  h.compactionSet = []
  h.provider = null
  vi.restoreAllMocks()
})

const msgs: ChatMessage[] = [
  { role: 'user', content: 'first' },
  { role: 'assistant', content: 'reply' },
  { role: 'user', content: 'recent' },
  { role: 'assistant', content: 'recent reply' }
]

describe('applyCompaction', () => {
  it('replaces the head with a summary pair and keeps the tail', () => {
    const out = applyCompaction(msgs, 2, 'dense summary')
    expect(out).toHaveLength(4) // 2 summary messages + 2 kept
    expect(out[0].role).toBe('user')
    expect(out[0].content).toContain(COMPACTION_SUMMARY_PREFIX)
    expect(out[0].content).toContain('dense summary')
    expect(out[1].role).toBe('assistant')
    expect(out.slice(2)).toEqual(msgs.slice(2))
  })

  it('keeps everything when cut is 0 (just the summary pair prepended)', () => {
    const out = applyCompaction(msgs, 0, 'S')
    expect(out.slice(2)).toEqual(msgs)
  })
})

describe('compactConversationNow', () => {
  /** A conversation whose head turns are each ~`tokensPerTurn` big. */
  function bigConversation(headTurns: number, tokensPerTurn: number): ChatMessage[] {
    const filler = 'x'.repeat(tokensPerTurn * 4)
    const out: ChatMessage[] = []
    for (let t = 0; t < headTurns; t++) {
      out.push({ role: 'user', content: `q${t} ${filler}` })
      out.push({ role: 'assistant', content: `a${t}` })
    }
    // Three small recent turns are kept verbatim (KEEP_RECENT_USER_TURNS).
    for (let t = 0; t < 3; t++) {
      out.push({ role: 'user', content: `recent ${t}` })
      out.push({ role: 'assistant', content: `recent a${t}` })
    }
    return out
  }

  it('summarizes an already-overflown chat in chunks that never overflow', async () => {
    // Head of three ~80k-token turns (~240k total) — far past the 200k window. A
    // one-shot summary of the whole head would itself be rejected; chunking must not.
    const messages = bigConversation(3, 80_000)
    h.conv = { id: 'c1', workspace: '/w', messages }

    const requestSizes: number[] = []
    h.provider = {
      async *streamChat(req) {
        const size = estimateTokens(req.system ?? '', req.messages)
        requestSizes.push(size)
        if (size > 200_000) {
          yield { type: 'error', message: 'prompt is too long: too big > 200000 maximum' }
          return
        }
        yield { type: 'text', text: 'SUMMARY' }
        yield { type: 'done', stopReason: 'end_turn' }
      }
    }

    const res = await compactConversationNow('c1', 'anthropic', 'claude-test')

    expect(res.ok).toBe(true)
    expect(res.error).toBeUndefined()
    // Multiple bounded requests, every one safely under the window.
    expect(requestSizes.length).toBeGreaterThan(1)
    expect(Math.max(...requestSizes)).toBeLessThan(200_000)
    // The head was folded into a summary pair; the three recent turns are kept.
    const out = res.messages!
    expect(out[0].content).toContain(COMPACTION_SUMMARY_PREFIX)
    expect(out.slice(2)).toEqual(messages.slice(6))
    expect(res.summarized).toBe(6)
    expect(h.saved).toEqual(out)
    // The rewrite invalidates any loop-persisted compaction state (its cut indexes
    // the old log), so the manual compact must clear it alongside the new log.
    expect(h.compactionSet).toEqual([null])
  })

  it('does nothing when the whole conversation already fits the kept-tail budget', async () => {
    h.conv = { id: 'c2', workspace: '/w', messages: msgs }
    h.provider = {
      // eslint-disable-next-line require-yield
      async *streamChat() {
        throw new Error('should not be called')
      }
    }
    const res = await compactConversationNow('c2', 'anthropic', 'claude-test')
    expect(res).toEqual({ ok: true, summarized: 0, reason: 'empty' })
    expect(h.saved).toBeNull()
    expect(h.compactionSet).toEqual([]) // nothing rewritten — stored state untouched
  })

  it('compacts a long chat made of only a couple of large turns', async () => {
    // The fixed keep-3 rule would refuse (≤3 user turns); the budget-aware cut must not.
    const messages: ChatMessage[] = [
      { role: 'user', content: `q0 ${'x'.repeat(400_000)}` }, // ~100k tokens
      { role: 'assistant', content: 'a0' },
      { role: 'user', content: 'q1 (small recent turn)' },
      { role: 'assistant', content: 'a1' }
    ]
    h.conv = { id: 'c2b', workspace: '/w', messages }
    h.provider = {
      async *streamChat() {
        yield { type: 'text', text: 'SUMMARY' }
        yield { type: 'done', stopReason: 'end_turn' }
      }
    }
    const res = await compactConversationNow('c2b', 'anthropic', 'claude-test')
    expect(res.ok).toBe(true)
    expect(res.summarized).toBe(2) // the big first turn folded away
    expect(res.messages![0].content).toContain(COMPACTION_SUMMARY_PREFIX)
    expect(res.messages!.slice(2)).toEqual(messages.slice(2)) // small recent turn kept verbatim
  })

  it('explains that a single huge turn cannot be compacted', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: `one giant request ${'x'.repeat(400_000)}` },
      { role: 'assistant', content: 'a' }
    ]
    h.conv = { id: 'c2c', workspace: '/w', messages }
    h.provider = {
      // eslint-disable-next-line require-yield
      async *streamChat() {
        throw new Error('should not be called')
      }
    }
    const res = await compactConversationNow('c2c', 'anthropic', 'claude-test')
    expect(res).toEqual({ ok: true, summarized: 0, reason: 'single-turn' })
    expect(h.saved).toBeNull()
  })

  it('reports an empty-summary failure without persisting', async () => {
    h.conv = { id: 'c3', workspace: '/w', messages: bigConversation(2, 40_000) }
    h.provider = {
      async *streamChat() {
        yield { type: 'text', text: '   ' } // whitespace only → empty after trim
        yield { type: 'done', stopReason: 'end_turn' }
      }
    }
    const res = await compactConversationNow('c3', 'anthropic', 'claude-test')
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/empty summary/)
    expect(h.saved).toBeNull()
    expect(h.compactionSet).toEqual([]) // failed — stored state untouched
  })
})
