import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, Provider } from '@shared/agent'
import { COMPACTION_SUMMARY_PREFIX, estimateTokens, summaryMaxTokens } from './compaction'

// Hoisted holders the mocks read, so each test can swap conversation/provider.
const h = vi.hoisted(() => ({
  conv: null as { id: string; workspace: string; messages: ChatMessage[] } | null,
  saved: null as ChatMessage[] | null,
  // Arguments of every setCompaction call, so tests can assert the stored
  // loop-compaction state was cleared when (and only when) the log is rewritten.
  compactionSet: [] as unknown[],
  provider: null as Provider | null,
  // The provider's config, when a test needs more than the default (a small model).
  cfg: null as Record<string, unknown> | null,
  // The live run on the chat, if any (the loop's activeRunForConversation).
  activeRun: null as string | null
}))

vi.mock('../providers', () => ({ createProvider: () => h.provider }))
vi.mock('../agentHost', () => ({
  getProvider: () => h.cfg ?? { id: 'anthropic', kind: 'anthropic', models: [] }
}))
vi.mock('./loop', () => ({ activeRunForConversation: () => h.activeRun }))
vi.mock('../logger', () => ({ log: { warn: () => {}, info: () => {}, error: () => {} } }))
vi.mock('../conversations', () => ({
  getConversation: () => h.conv,
  peekConversation: () => h.conv,
  setMessages: (_id: string, m: ChatMessage[]) => {
    h.saved = m
  },
  setCompaction: (_id: string, c: unknown) => {
    h.compactionSet.push(c)
  }
}))

const { applyCompaction, cancelCompaction, compactConversationNow, compactionInProgress } = await import('./compact')

afterEach(() => {
  vi.useRealTimers()
  h.activeRun = null
  h.conv = null
  h.saved = null
  h.compactionSet = []
  h.provider = null
  h.cfg = null
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

  it("carries the dropped head's taint onto the summary, and none from a clean head", () => {
    const tainted: ChatMessage[] = [
      { role: 'user', content: 'read it' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'f1', name: 'web_fetch', arguments: { url: 'https://e.com' } }] },
      { role: 'tool', content: 'page', toolCallId: 'f1', toolName: 'web_fetch' },
      ...msgs
    ]
    const out = applyCompaction(tainted, 3, 'S')
    expect(out[0].taintSource).toBe('web_fetch')
    // A second compaction over the first summary keeps the mark.
    expect(applyCompaction(out, 2, 'S2')[0].taintSource).toBe('web_fetch')
    // Taint in the kept tail stays where it is; a clean head adds none.
    expect(applyCompaction(msgs, 2, 'S')[0]).not.toHaveProperty('taintSource')
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

  it('keeps a tainted head tainted after /compact rewrites the log', async () => {
    const messages = bigConversation(3, 20_000)
    messages.splice(1, 0, { role: 'assistant', content: '', toolCalls: [{ id: 'f1', name: 'web_fetch', arguments: { url: 'https://e.com' } }] }, {
      role: 'tool',
      content: 'page',
      toolCallId: 'f1',
      toolName: 'web_fetch'
    })
    h.conv = { id: 'c-taint', workspace: '/w', messages }
    h.provider = {
      async *streamChat() {
        yield { type: 'text', text: 'SUMMARY' }
        yield { type: 'done', stopReason: 'end_turn' }
      }
    }
    const res = await compactConversationNow('c-taint', 'anthropic', 'claude-test')
    expect(res.ok).toBe(true)
    // The fetch was summarized away; its mark is on the summary instead.
    expect(res.messages!.some((m) => m.toolCalls?.some((c) => c.name === 'web_fetch'))).toBe(false)
    expect(res.messages![0].taintSource).toBe('web_fetch')
  })

  it('passes a /compact focus to every summary request, and none without one', async () => {
    const seen: string[] = []
    h.provider = {
      async *streamChat(req) {
        seen.push(req.messages.at(-1)!.content)
        yield { type: 'text', text: 'SUMMARY' }
        yield { type: 'done', stopReason: 'end_turn' }
      }
    }
    h.conv = { id: 'cf', workspace: '/w', messages: bigConversation(3, 80_000) }
    await compactConversationNow('cf', 'anthropic', 'claude-test', { focus: '  the auth refactor  ' })
    expect(seen.length).toBeGreaterThan(1)
    for (const last of seen) expect(last).toContain('<focus>\nthe auth refactor\n</focus>')
    seen.length = 0
    h.conv = { id: 'cg', workspace: '/w', messages: bigConversation(3, 80_000) }
    await compactConversationNow('cg', 'anthropic', 'claude-test')
    for (const last of seen) expect(last).not.toContain('<focus>')
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

  it('rejects a summary cut off at the output limit instead of keeping it truncated', async () => {
    h.conv = { id: 'c4', workspace: '/w', messages: bigConversation(2, 40_000) }
    const caps: number[] = []
    h.provider = {
      async *streamChat(req) {
        caps.push(req.maxTokens ?? 0)
        yield { type: 'text', text: 'A summary that stops mid-sen' }
        yield { type: 'done', stopReason: 'max_tokens' }
      }
    }
    const res = await compactConversationNow('c4', 'anthropic', 'claude-test')
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/cut off at the model's output limit/)
    expect(h.saved).toBeNull()
    expect(h.compactionSet).toEqual([])
    // Not retried: the same request would stop at the same cap. And the cap is the
    // scaled one, well above the old fixed 2048 that thinking models exhausted.
    expect(caps).toHaveLength(1)
    expect(caps[0]).toBeGreaterThan(2048)
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

  it('gives up at the overall deadline when every attempt fails retryably', async () => {
    vi.useFakeTimers()
    h.conv = { id: 'd1', workspace: '/w', messages: bigConversation(2, 40_000) }
    let calls = 0
    h.provider = {
      async *streamChat() {
        calls++
        yield { type: 'error', message: 'overloaded', status: 529 }
      }
    }
    const retries: number[] = []
    const p = compactConversationNow('d1', 'anthropic', 'claude-test', {
      deadlineMs: 5_000,
      onRetry: (r) => retries.push(r.attempt)
    })
    await vi.advanceTimersByTimeAsync(5_000)
    const res = await p
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('timeout')
    expect(res.error).toMatch(/longer than 5 seconds/)
    expect(res.error).not.toContain('\u2014')
    expect(calls).toBeGreaterThan(0)
    // Retries surface to the caller instead of spinning in silence.
    expect(retries.length).toBeGreaterThan(0)
    expect(h.saved).toBeNull()
    expect(compactionInProgress('d1')).toBe(false)
  })

  it('returns promptly when cancelled, even with a provider that never answers', async () => {
    h.conv = { id: 'd2', workspace: '/w', messages: bigConversation(2, 40_000) }
    let started!: () => void
    const inStream = new Promise<void>((r) => (started = r))
    h.provider = {
      // eslint-disable-next-line require-yield
      async *streamChat() {
        started()
        await new Promise(() => {}) // hangs, ignoring the signal
      }
    }
    const ctl = new AbortController()
    const p = compactConversationNow('d2', 'anthropic', 'claude-test', { signal: ctl.signal })
    await inStream
    expect(compactionInProgress('d2')).toBe(true)
    ctl.abort()
    const res = await p
    expect(res).toMatchObject({ ok: false, reason: 'cancelled' })
    expect(h.saved).toBeNull()
    expect(compactionInProgress('d2')).toBe(false)
  })

  it('cancels an in-flight compaction by conversation id', async () => {
    h.conv = { id: 'd3', workspace: '/w', messages: bigConversation(2, 40_000) }
    let started!: () => void
    const inStream = new Promise<void>((r) => (started = r))
    h.provider = {
      // eslint-disable-next-line require-yield
      async *streamChat() {
        started()
        await new Promise(() => {})
      }
    }
    expect(cancelCompaction('d3')).toBe(false) // nothing in flight yet
    const p = compactConversationNow('d3', 'anthropic', 'claude-test')
    await inStream
    // A second compaction of the same chat is refused while the first runs.
    expect(await compactConversationNow('d3', 'anthropic', 'claude-test')).toMatchObject({ ok: false, reason: 'busy' })
    expect(cancelCompaction('d3')).toBe(true)
    expect(await p).toMatchObject({ ok: false, reason: 'cancelled' })
    expect(h.saved).toBeNull()
  })

  it('returns at once for an already-aborted signal', async () => {
    h.conv = { id: 'd4', workspace: '/w', messages: bigConversation(2, 40_000) }
    h.provider = {
      // eslint-disable-next-line require-yield
      async *streamChat() {
        throw new Error('should not be called')
      }
    }
    const ctl = new AbortController()
    ctl.abort()
    expect(await compactConversationNow('d4', 'anthropic', 'claude-test', { signal: ctl.signal })).toMatchObject({
      ok: false,
      reason: 'cancelled'
    })
  })

  it('does not overwrite a conversation that changed while it was being summarized', async () => {
    const messages = bigConversation(2, 40_000)
    h.conv = { id: 'd5', workspace: '/w', messages }
    h.provider = {
      async *streamChat() {
        // A new turn lands in the store while the summary is being written.
        h.conv = { id: 'd5', workspace: '/w', messages: [...messages, { role: 'user', content: 'newer turn' }] }
        yield { type: 'text', text: 'SUMMARY' }
        yield { type: 'done', stopReason: 'end_turn' }
      }
    }
    const res = await compactConversationNow('d5', 'anthropic', 'claude-test')
    expect(res).toMatchObject({ ok: false, reason: 'changed' })
    expect(h.saved).toBeNull()
    expect(h.compactionSet).toEqual([])
  })

  it('does not overwrite when a run started on the chat mid-compaction', async () => {
    h.conv = { id: 'd6', workspace: '/w', messages: bigConversation(2, 40_000) }
    h.provider = {
      async *streamChat() {
        h.activeRun = 'run-1'
        yield { type: 'text', text: 'SUMMARY' }
        yield { type: 'done', stopReason: 'end_turn' }
      }
    }
    const res = await compactConversationNow('d6', 'anthropic', 'claude-test')
    expect(res).toMatchObject({ ok: false, reason: 'running' })
    expect(h.saved).toBeNull()
  })

  it('refuses to start while a run is live on the chat', async () => {
    h.conv = { id: 'd7', workspace: '/w', messages: bigConversation(2, 40_000) }
    h.activeRun = 'run-2'
    h.provider = {
      // eslint-disable-next-line require-yield
      async *streamChat() {
        throw new Error('should not be called')
      }
    }
    expect(await compactConversationNow('d7', 'anthropic', 'claude-test')).toMatchObject({ ok: false, reason: 'running' })
  })

  describe('which model writes the summary', () => {
    /** A provider config with a chat model and a small one, both with known windows. */
    function withSmallModel(smallModel: string, smallWindow = 200_000): void {
      h.cfg = {
        id: 'anthropic',
        kind: 'anthropic',
        smallModel,
        models: [
          { id: 'claude-test', caps: { contextWindow: 200_000 } },
          { id: 'claude-small', caps: { contextWindow: smallWindow } }
        ]
      }
    }

    /** A provider that summarizes, recording each request's model and output cap. */
    function recording(fail?: (model: string) => boolean): { model: string; maxTokens?: number }[] {
      const seen: { model: string; maxTokens?: number }[] = []
      h.provider = {
        async *streamChat(req) {
          seen.push({ model: req.model, maxTokens: req.maxTokens })
          if (fail?.(req.model)) {
            yield { type: 'error', message: 'model not found', status: 404 }
            return
          }
          yield { type: 'text', text: `SUMMARY by ${req.model}` }
          yield { type: 'done', stopReason: 'end_turn' }
        }
      }
      return seen
    }

    it("writes every chunk on the provider's small model, sized to its window", async () => {
      withSmallModel('claude-small', 400_000)
      h.conv = { id: 's1', workspace: '/w', messages: bigConversation(3, 80_000) }
      const seen = recording()
      const res = await compactConversationNow('s1', 'anthropic', 'claude-test')
      expect(res.ok).toBe(true)
      expect(seen.length).toBeGreaterThan(1)
      expect(seen.every((r) => r.model === 'claude-small')).toBe(true)
      expect(seen[0].maxTokens).toBe(summaryMaxTokens(400_000))
      expect(res.messages![0].content).toContain('SUMMARY by claude-small')
    })

    it("falls back to the chat's model for a chunk the small model fails", async () => {
      withSmallModel('claude-small')
      h.conv = { id: 's2', workspace: '/w', messages: bigConversation(2, 40_000) }
      const seen = recording((model) => model === 'claude-small')
      const res = await compactConversationNow('s2', 'anthropic', 'claude-test')
      expect(res.ok).toBe(true)
      expect(seen.map((r) => r.model)).toEqual(['claude-small', 'claude-test'])
      expect(seen[1].maxTokens).toBe(summaryMaxTokens(200_000))
      expect(res.messages![0].content).toContain('SUMMARY by claude-test')
    })

    it("uses the chat's model for a chunk too big for the small model's window", async () => {
      withSmallModel('claude-small', 60_000)
      h.conv = { id: 's3', workspace: '/w', messages: bigConversation(2, 40_000) }
      const seen = recording()
      const res = await compactConversationNow('s3', 'anthropic', 'claude-test')
      expect(res.ok).toBe(true)
      expect(seen.length).toBeGreaterThan(0)
      expect(seen.every((r) => r.model === 'claude-test')).toBe(true)
    })

    it("stays on the chat's model when the provider is set to use it for side requests", async () => {
      withSmallModel('')
      h.conv = { id: 's4', workspace: '/w', messages: bigConversation(2, 40_000) }
      const seen = recording()
      const res = await compactConversationNow('s4', 'anthropic', 'claude-test')
      expect(res.ok).toBe(true)
      expect(seen.map((r) => r.model)).toEqual(['claude-test'])
    })
  })
})
