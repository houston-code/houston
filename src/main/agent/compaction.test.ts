import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/agent'
import {
  COMPACTION_SUMMARY_PREFIX,
  DOCUMENT_TOKENS_ESTIMATE,
  IMAGE_TOKENS_ESTIMATE,
  EVICT_KEEP_RECENT_TURNS,
  EVICT_MIN_BYTES,
  buildSummaryMessages,
  buildSummaryRequestMessages,
  estimateTokens,
  evictStaleToolResults,
  evictionStub,
  findCompactionCut,
  findCompactionCutByBudget,
  findForcedCompactionCut,
  findSummaryChunkCut,
  isContextOverflowError
} from './compaction'

/** A conversation of `turns` complete turns: user → assistant(tool) → tool → assistant. */
function conversation(turns: number): ChatMessage[] {
  const msgs: ChatMessage[] = []
  for (let t = 0; t < turns; t++) {
    msgs.push({ role: 'user', content: `question ${t}` })
    msgs.push({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: `c${t}`, name: 'read_file', arguments: { path: `f${t}.ts` } }]
    })
    msgs.push({ role: 'tool', content: `contents ${t}`, toolCallId: `c${t}`, toolName: 'read_file' })
    msgs.push({ role: 'assistant', content: `answer ${t}` })
  }
  return msgs
}

describe('estimateTokens', () => {
  it('grows with content and counts tool-call arguments', () => {
    const small = estimateTokens('sys', [{ role: 'user', content: 'hi' }])
    const big = estimateTokens('sys', [{ role: 'user', content: 'x'.repeat(4000) }])
    expect(big).toBeGreaterThan(small)
    expect(big).toBeGreaterThan(1000) // ~4 chars/token over 4000 chars
  })

  it('includes the system prompt and tool-call argument JSON', () => {
    const withTool = estimateTokens('', [
      { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'write_file', arguments: { path: 'a', content: 'y'.repeat(400) } }] }
    ])
    const withoutTool = estimateTokens('', [{ role: 'assistant', content: '' }])
    expect(withTool).toBeGreaterThan(withoutTool + 90)
  })

  it('counts image and document attachments that barely touch text content', () => {
    const base: ChatMessage = { role: 'user', content: 'see attached' }
    const plain = estimateTokens('', [base])
    const withImages = estimateTokens('', [
      { ...base, images: [{ mediaType: 'image/png', data: 'x' }, { mediaType: 'image/png', data: 'y' }] }
    ])
    const withDoc = estimateTokens('', [{ ...base, documents: [{ mediaType: 'application/pdf', data: 'z' }] }])
    expect(withImages).toBe(plain + 2 * IMAGE_TOKENS_ESTIMATE)
    expect(withDoc).toBe(plain + DOCUMENT_TOKENS_ESTIMATE)
  })
})

describe('findCompactionCutByBudget', () => {
  // ~1k tokens per user turn (4k chars / 4) on the user message of each turn.
  const turns = (n: number): ChatMessage[] => {
    const msgs: ChatMessage[] = []
    for (let t = 0; t < n; t++) {
      msgs.push({ role: 'user', content: 'x'.repeat(4000) })
      msgs.push({ role: 'assistant', content: `a${t}` })
    }
    return msgs
  }

  it('compacts a few large turns that the fixed keep-3 rule would refuse', () => {
    const msgs = turns(3) // user turns at 0, 2, 4 — each ~1k tokens
    // findCompactionCut keeps the last 3 user turns → refuses to compact 3 turns.
    expect(findCompactionCut(msgs, 0, 3)).toBe(0)
    // Budget-aware: a 1.5k budget can't hold all three, so it keeps fewer and compacts.
    const cut = findCompactionCutByBudget(msgs, 3, 1500)
    expect(cut).toBeGreaterThan(0)
    expect(msgs[cut].role).toBe('user')
  })

  it('keeps more recent turns when they comfortably fit the budget', () => {
    const msgs = turns(5) // user turns at 0,2,4,6,8
    // A generous budget keeps the full maxKeepTurns (3) and summarizes the rest.
    expect(findCompactionCutByBudget(msgs, 3, 1_000_000)).toBe(4)
  })

  it('keeps at least one turn when even a single turn exceeds the budget', () => {
    const msgs = turns(3)
    const cut = findCompactionCutByBudget(msgs, 3, 10) // budget below one turn
    expect(cut).toBe(4) // the last user turn, alone
  })

  it('returns 0 for a single turn (nothing earlier to summarize)', () => {
    expect(findCompactionCutByBudget(turns(1), 3, 1000)).toBe(0)
    expect(findCompactionCutByBudget([], 3, 1000)).toBe(0)
  })
})

describe('findForcedCompactionCut', () => {
  it('advances one user turn at a time toward the latest turn', () => {
    const msgs = conversation(5) // user messages at indices 0,4,8,12,16
    const a = findForcedCompactionCut(msgs, 0)
    expect(a).toBe(4)
    const b = findForcedCompactionCut(msgs, a)
    expect(b).toBe(8)
  })

  it('never cuts away the final user turn (the request being sent)', () => {
    const msgs = conversation(3) // user messages at 0, 4, 8
    // From a cut that already keeps only the last two turns, it stops at the last.
    expect(findForcedCompactionCut(msgs, 4)).toBe(8)
    // Already keeping only the final turn — nothing left to compact away.
    expect(findForcedCompactionCut(msgs, 8)).toBe(8)
  })

  it('cannot advance a single-turn conversation', () => {
    const msgs = conversation(1) // one user turn at index 0
    expect(findForcedCompactionCut(msgs, 0)).toBe(0)
  })

  it('lands on a user boundary so the kept tail stays valid', () => {
    const msgs = conversation(4)
    const cut = findForcedCompactionCut(msgs, 0)
    expect(msgs[cut].role).toBe('user')
    expect(msgs.slice(cut)[0].toolCallId).toBeUndefined()
  })
})

describe('findSummaryChunkCut', () => {
  // ~1k tokens of text per turn (4k chars / 4) so budgets are easy to reason about.
  const big = (turns: number): ChatMessage[] => {
    const msgs: ChatMessage[] = []
    for (let t = 0; t < turns; t++) {
      msgs.push({ role: 'user', content: 'x'.repeat(4000) })
      msgs.push({ role: 'assistant', content: `a${t}` })
    }
    return msgs
  }

  it('packs as many whole turns as fit the budget', () => {
    const msgs = big(5) // user turns at 0,2,4,6,8 — each ~1k tokens
    const cut = findSummaryChunkCut(msgs, 0, msgs.length, 2500)
    // Two turns (~2k) fit under 2500; a third would exceed it.
    expect(cut).toBe(4)
    expect(msgs[cut].role).toBe('user')
  })

  it('always advances at least one turn even if it exceeds the budget', () => {
    const msgs = big(3)
    const cut = findSummaryChunkCut(msgs, 0, msgs.length, 10) // budget below one turn
    expect(cut).toBe(2) // the first turn, alone
  })

  it('walking it in a loop covers the whole head', () => {
    const msgs = big(5)
    const end = 8 // keep the last turn; summarize [0,8)
    const cuts: number[] = []
    let cur = 0
    while (cur < end) {
      cur = findSummaryChunkCut(msgs, cur, end, 2500)
      cuts.push(cur)
    }
    expect(cuts.at(-1)).toBe(end)
    expect(cuts.every((c, i) => i === 0 || c > cuts[i - 1])).toBe(true) // strictly increasing
  })
})

describe('isContextOverflowError', () => {
  it('detects the Anthropic, OpenAI, and Gemini overflow phrasings', () => {
    expect(isContextOverflowError(new Error('prompt is too long: 212129 tokens > 200000 maximum'))).toBe(true)
    expect(isContextOverflowError({ status: 400, message: 'context_length_exceeded' })).toBe(true)
    expect(isContextOverflowError(new Error("This model's maximum context length is 128000 tokens"))).toBe(true)
    expect(isContextOverflowError(new Error('Please reduce the length of the messages'))).toBe(true)
    expect(isContextOverflowError(new Error('The input token count (300000) exceeds the maximum number of tokens'))).toBe(true)
  })

  it('does not flag unrelated errors', () => {
    expect(isContextOverflowError(new Error('invalid api key'))).toBe(false)
    expect(isContextOverflowError(new Error('old_string was not found'))).toBe(false)
    expect(isContextOverflowError({ status: 429, message: 'rate limit exceeded' })).toBe(false)
    expect(isContextOverflowError(new Error('Overloaded'))).toBe(false)
  })

  it('ignores overflow-sounding text on a non-4xx status (likely a server error)', () => {
    expect(isContextOverflowError({ status: 500, message: 'token count exceeded internally' })).toBe(false)
  })
})

describe('findCompactionCut', () => {
  it('does not compact when there are at most keepRecentUserTurns turns', () => {
    const msgs = conversation(3)
    expect(findCompactionCut(msgs, 0, 3)).toBe(0)
  })

  it('cuts at a user boundary, keeping the last N turns', () => {
    const msgs = conversation(5) // user messages at indices 0,4,8,12,16
    const cut = findCompactionCut(msgs, 0, 2)
    expect(cut).toBe(12) // keep the last 2 user turns (indices 12.. and 16..)
    expect(msgs[cut].role).toBe('user')
  })

  it('keeps complete turns: everything from the cut onward starts with a user turn', () => {
    const msgs = conversation(5)
    const cut = findCompactionCut(msgs, 0, 3)
    const tail = msgs.slice(cut)
    expect(tail[0].role).toBe('user')
    // No orphaned tool result at the very start of the kept tail.
    expect(tail[0].toolCallId).toBeUndefined()
  })

  it('returns the current cut when it cannot advance further', () => {
    const msgs = conversation(5)
    const first = findCompactionCut(msgs, 0, 2)
    expect(findCompactionCut(msgs, first, 2)).toBe(first)
  })

  it('never moves the cut backwards', () => {
    const msgs = conversation(6)
    expect(findCompactionCut(msgs, 100, 2)).toBe(100)
  })
})

describe('buildSummaryMessages', () => {
  it('returns a user/assistant pair so role alternation stays valid', () => {
    const pair = buildSummaryMessages('did stuff')
    expect(pair).toHaveLength(2)
    expect(pair[0].role).toBe('user')
    expect(pair[0].content).toContain(COMPACTION_SUMMARY_PREFIX)
    expect(pair[0].content).toContain('did stuff')
    expect(pair[1].role).toBe('assistant')
  })
})

describe('buildSummaryRequestMessages', () => {
  it('folds prior summary + head and ends with a user instruction', () => {
    const prior = buildSummaryMessages('older summary')
    const head = conversation(2)
    const req = buildSummaryRequestMessages(prior, head)
    expect(req[0].role).toBe('user')
    expect(req[0].content).toContain('older summary')
    expect(req[req.length - 1].role).toBe('user')
    expect(req.length).toBe(prior.length + head.length + 1)
  })

  it('works with no prior summary (first compaction)', () => {
    const head = conversation(2)
    const req = buildSummaryRequestMessages([], head)
    expect(req[0].role).toBe('user') // head starts with a user message
    expect(req[req.length - 1].role).toBe('user') // the instruction
  })
})

/** A window whose first turns carry large tool results, the last `recent` turns kept. */
function windowWithLargeToolResults(totalTurns: number): ChatMessage[] {
  const big = 'z'.repeat(EVICT_MIN_BYTES + 500)
  const msgs: ChatMessage[] = []
  for (let t = 0; t < totalTurns; t++) {
    msgs.push({ role: 'user', content: `q${t}` })
    msgs.push({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: `c${t}`, name: 'read_file', arguments: { path: `f${t}.ts` } }]
    })
    msgs.push({ role: 'tool', content: big, toolCallId: `c${t}`, toolName: 'read_file' })
    msgs.push({ role: 'assistant', content: `a${t}` })
  }
  return msgs
}

describe('evictionStub', () => {
  it('names the tool, subject, and byte count and points at recall', () => {
    const stub = evictionStub('read_file', 'src/big.ts', 12345)
    expect(stub).toBe('[earlier read_file result on src/big.ts, 12345 bytes elided — recall_history or re-run to view]')
  })

  it('omits the subject clause when there is none, and falls back to "tool"', () => {
    expect(evictionStub(undefined, '', 10)).toBe('[earlier tool result, 10 bytes elided — recall_history or re-run to view]')
  })
})

describe('evictStaleToolResults', () => {
  it('evicts stale + large tool results but keeps recent ones verbatim', () => {
    const total = EVICT_KEEP_RECENT_TURNS + 2 // 2 turns are stale
    const window = windowWithLargeToolResults(total)
    const out = evictStaleToolResults(window)

    const toolMsgs = out.filter((m) => m.role === 'tool')
    const stubbed = toolMsgs.filter((m) => m.content.startsWith('[earlier '))
    const verbatim = toolMsgs.filter((m) => !m.content.startsWith('[earlier '))
    expect(stubbed).toHaveLength(2) // the two oldest turns
    expect(verbatim).toHaveLength(EVICT_KEEP_RECENT_TURNS)

    // Stub names the tool + subject (from the matching tool_use path arg).
    expect(stubbed[0].content).toContain('read_file result on f0.ts')
    // toolCallId/toolName preserved so pairing stays valid.
    expect(stubbed[0].toolCallId).toBe('c0')
    expect(stubbed[0].toolName).toBe('read_file')
  })

  it('does not mutate the input window', () => {
    const window = windowWithLargeToolResults(EVICT_KEEP_RECENT_TURNS + 1)
    const before = JSON.stringify(window)
    evictStaleToolResults(window)
    expect(JSON.stringify(window)).toBe(before)
  })

  it('keeps small stale tool results verbatim', () => {
    // Same shape, but tiny tool outputs — below the byte threshold, so kept.
    const msgs: ChatMessage[] = []
    for (let t = 0; t < EVICT_KEEP_RECENT_TURNS + 2; t++) {
      msgs.push({ role: 'user', content: `q${t}` })
      msgs.push({
        role: 'assistant',
        content: '',
        toolCalls: [{ id: `c${t}`, name: 'read_file', arguments: { path: `f${t}.ts` } }]
      })
      msgs.push({ role: 'tool', content: 'ok', toolCallId: `c${t}`, toolName: 'read_file' })
      msgs.push({ role: 'assistant', content: `a${t}` })
    }
    const out = evictStaleToolResults(msgs)
    expect(out).toBe(msgs) // unchanged reference — nothing evicted
  })

  it('leaves an already-stubbed result alone (no recall/eviction ping-pong)', () => {
    const window = windowWithLargeToolResults(EVICT_KEEP_RECENT_TURNS + 1)
    // Pre-stub the oldest tool result.
    const oldToolIdx = window.findIndex((m) => m.role === 'tool')
    window[oldToolIdx] = {
      ...window[oldToolIdx],
      content: '[earlier read_file result on f0.ts, 3000 bytes elided — recall_history or re-run to view]'
    }
    const out = evictStaleToolResults(window)
    expect(out[oldToolIdx].content).toBe(window[oldToolIdx].content)
  })

  it('evicts a stale tool result carrying attachments even when its text is small', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'q0' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c0', name: 'read_file', arguments: { path: 'img.png' } }] },
      {
        role: 'tool',
        content: '[image attached]',
        toolCallId: 'c0',
        toolName: 'read_file',
        images: [{ mediaType: 'image/png', data: 'AAAA' }]
      },
      { role: 'assistant', content: 'a0' }
    ]
    // Pad with recent kept turns so turn 0 is stale.
    for (let t = 1; t <= EVICT_KEEP_RECENT_TURNS; t++) {
      msgs.push({ role: 'user', content: `q${t}` }, { role: 'assistant', content: `a${t}` })
    }
    const out = evictStaleToolResults(msgs)
    const stub = out.find((m) => m.role === 'tool')!
    expect(stub.content.startsWith('[earlier ')).toBe(true)
    expect(stub.images).toBeUndefined() // attachment dropped
  })

  it('returns the input unchanged when nothing is old enough to be stale', () => {
    const window = windowWithLargeToolResults(EVICT_KEEP_RECENT_TURNS)
    expect(evictStaleToolResults(window)).toBe(window)
  })
})
