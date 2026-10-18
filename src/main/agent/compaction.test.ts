import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/agent'
import { DEFAULT_COMPACTION_THRESHOLD } from '@shared/defaults'
import {
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_WINDOW_FRACTION,
  DOCUMENT_TOKENS_ESTIMATE,
  IMAGE_TOKENS_ESTIMATE,
  EVICT_KEEP_RECENT_ITERATIONS,
  EVICT_KEEP_RECENT_TURNS,
  EVICT_MIN_BYTES,
  SUMMARY_MAX_TOKENS,
  buildSummaryMessages,
  buildSummaryRequestMessages,
  compactionAnchor,
  compactionCandidates,
  estimateTokens,
  evictStaleToolResults,
  evictionBoundary,
  evictionStub,
  findCompactionCut,
  findCompactionCutByBudget,
  findForcedCompactionCut,
  findSummaryChunkCut,
  hasEvictableToolResults,
  isContextOverflowError,
  isValidCompactionState,
  resolveCompactionThreshold,
  summaryMaxTokens
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

/**
 * One request followed by `iterations` tool rounds, each reading a `size`-char file:
 * the shape of a single long prompt. The request is at 0; iteration i's assistant
 * message is at 1 + 2i and its result at 2 + 2i.
 */
function longTurn(iterations: number, size = 20_000): ChatMessage[] {
  const msgs: ChatMessage[] = [{ role: 'user', content: 'refactor the parser' }]
  for (let i = 0; i < iterations; i++) {
    msgs.push({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: `r${i}`, name: 'read_file', arguments: { path: `f${i}.ts` } }]
    })
    msgs.push({ role: 'tool', content: 'x'.repeat(size), toolCallId: `r${i}`, toolName: 'read_file' })
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

describe('resolveCompactionThreshold', () => {
  it('scales to the model context window when no explicit setting is given', () => {
    expect(resolveCompactionThreshold(undefined, 200_000)).toBe(
      Math.floor(200_000 * COMPACTION_WINDOW_FRACTION)
    )
    expect(resolveCompactionThreshold(undefined, 1_000_000)).toBe(
      Math.floor(1_000_000 * COMPACTION_WINDOW_FRACTION)
    )
    // A small local model compacts far below the old fixed default.
    expect(resolveCompactionThreshold(undefined, 16_385)).toBeLessThan(16_385)
  })

  it('falls back to the fixed default when the window is unknown', () => {
    expect(resolveCompactionThreshold(undefined, null)).toBe(DEFAULT_COMPACTION_THRESHOLD)
    expect(resolveCompactionThreshold(undefined, 0)).toBe(DEFAULT_COMPACTION_THRESHOLD)
  })

  it('lets an explicit setting override the window-relative sizing', () => {
    expect(resolveCompactionThreshold(50_000, 1_000_000)).toBe(50_000)
    expect(resolveCompactionThreshold(50_000, null)).toBe(50_000)
  })

  it('keeps 0 meaning "compaction disabled", window or not', () => {
    expect(resolveCompactionThreshold(0, 200_000)).toBe(0)
    expect(resolveCompactionThreshold(0, null)).toBe(0)
    expect(resolveCompactionThreshold(-5, 200_000)).toBe(0) // clamp junk to disabled
  })

  it('ignores a non-finite explicit value', () => {
    expect(resolveCompactionThreshold(Number.NaN, 200_000)).toBe(
      Math.floor(200_000 * COMPACTION_WINDOW_FRACTION)
    )
  })
})

describe('isValidCompactionState', () => {
  const log = conversation(3) // 12 messages; user turns at 0, 4, 8

  it('accepts a cut on a user-turn boundary with a non-empty summary', () => {
    expect(isValidCompactionState({ cut: 4, summary: 'S' }, log)).toBe(true)
    expect(isValidCompactionState({ cut: 8, summary: 'S' }, log)).toBe(true)
  })

  it('rejects a cut that does not land on a user message', () => {
    expect(isValidCompactionState({ cut: 1, summary: 'S' }, log)).toBe(false)
    expect(isValidCompactionState({ cut: 2, summary: 'S' }, log)).toBe(false)
  })

  it('rejects a cut outside the log (e.g. the log was rewritten shorter)', () => {
    expect(isValidCompactionState({ cut: 12, summary: 'S' }, log)).toBe(false)
    expect(isValidCompactionState({ cut: 99, summary: 'S' }, log)).toBe(false)
  })

  it('accepts a cut inside a turn when it is anchored to that turn\'s request', () => {
    const turn = longTurn(3) // request at 0; iterations open at 1, 3, 5
    expect(isValidCompactionState({ cut: 3, summary: 'S', anchor: 0 }, turn)).toBe(true)
  })

  it('rejects an anchor that is not a user message before an assistant cut', () => {
    const turn = longTurn(3)
    expect(isValidCompactionState({ cut: 3, summary: 'S', anchor: 1 }, turn)).toBe(false) // not a user
    expect(isValidCompactionState({ cut: 3, summary: 'S', anchor: 3 }, turn)).toBe(false) // not before the cut
    expect(isValidCompactionState({ cut: 3, summary: 'S', anchor: 0.5 }, turn)).toBe(false)
    expect(isValidCompactionState({ cut: 3, summary: 'S' }, turn)).toBe(false) // mid-turn, unanchored
    // A cut on a user boundary must not carry an anchor (nothing to re-send).
    expect(isValidCompactionState({ cut: 4, summary: 'S', anchor: 0 }, log)).toBe(false)
  })

  it('accepts eviction-only state, and checks the watermark against the log', () => {
    expect(isValidCompactionState({ cut: 0, summary: '', evictBefore: 6 }, log)).toBe(true)
    expect(isValidCompactionState({ cut: 4, summary: 'S', evictBefore: 12 }, log)).toBe(true)
    expect(isValidCompactionState({ cut: 0, summary: '', evictBefore: 13 }, log)).toBe(false)
    expect(isValidCompactionState({ cut: 0, summary: '', evictBefore: 2.5 }, log)).toBe(false)
    expect(isValidCompactionState({ cut: 0, summary: '', evictBefore: 0 }, log)).toBe(false)
    expect(isValidCompactionState({ cut: 0, summary: '' }, log)).toBe(false) // empty state
  })

  it('rejects the no-op cut 0 and malformed values', () => {
    expect(isValidCompactionState({ cut: 0, summary: 'S' }, log)).toBe(false)
    expect(isValidCompactionState({ cut: 4.5, summary: 'S' }, log)).toBe(false)
    expect(isValidCompactionState({ cut: 4, summary: '   ' }, log)).toBe(false)
    // A hand-edited file can carry anything — type-check at runtime too.
    expect(
      isValidCompactionState({ cut: 4, summary: 7 as unknown as string }, log)
    ).toBe(false)
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
  it('halves the verbatim tail in one step instead of creeping a turn at a time', () => {
    const msgs = conversation(8) // user messages at 0, 4, …, 28
    const whole = estimateTokens('', msgs)
    const cut = findForcedCompactionCut(msgs, 0)
    expect(msgs[cut].role).toBe('user')
    expect(estimateTokens('', msgs.slice(cut))).toBeLessThanOrEqual(whole / 2)
    // The earliest boundary that does it: one turn more would not have halved it.
    expect(estimateTokens('', msgs.slice(cut - 4))).toBeGreaterThan(whole / 2)
  })

  it('never cuts away the request when its turn has not run an iteration yet', () => {
    const msgs: ChatMessage[] = [...conversation(3), { role: 'user', content: 'current question' }]
    let cut = 0
    for (let i = 0; i < 10; i++) cut = findForcedCompactionCut(msgs, cut)
    expect(cut).toBe(12) // the request being sent, alone
  })

  it('cuts inside a single long turn, after a complete tool-result block', () => {
    const msgs = longTurn(8)
    const cut = findForcedCompactionCut(msgs, 0)
    expect(cut).toBeGreaterThan(1) // past the first iteration: something is summarized
    expect(msgs[cut].role).toBe('assistant')
    expect(msgs[cut - 1].role).toBe('tool')
    expect(estimateTokens('', msgs.slice(cut))).toBeLessThanOrEqual(estimateTokens('', msgs) / 2)
  })

  it('keeps the newest iteration however hard it is pushed', () => {
    const msgs = longTurn(6)
    let cut = 0
    for (let i = 0; i < 20; i++) cut = findForcedCompactionCut(msgs, cut)
    expect(cut).toBe(msgs.length - 2) // the last assistant message, with its result
  })

  it('cannot advance when only the request and its first iteration remain', () => {
    expect(findForcedCompactionCut(longTurn(1), 0)).toBe(0)
    expect(findForcedCompactionCut([{ role: 'user', content: 'huge paste' }], 0)).toBe(0)
  })

  it('lands on a turn or iteration boundary so the kept tail stays valid', () => {
    for (const msgs of [conversation(4), longTurn(5)]) {
      const cut = findForcedCompactionCut(msgs, 0)
      expect(['user', 'assistant']).toContain(msgs[cut].role)
      expect(msgs[cut].toolCallId).toBeUndefined() // never opens on an orphaned result
    }
  })
})

describe('compactionCandidates', () => {
  it('never offers a steer or note inside the current turn', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'the request' }, // 0: turnStart
      { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'list_dir', arguments: {} }] },
      { role: 'tool', content: 'ok', toolCallId: 'a', toolName: 'list_dir' },
      { role: 'user', content: 'actually, update the docs too' }, // 3: a steer
      { role: 'assistant', content: '', toolCalls: [{ id: 'b', name: 'list_dir', arguments: {} }] },
      { role: 'tool', content: 'ok', toolCallId: 'b', toolName: 'list_dir' },
      { role: 'assistant', content: 'done' }
    ]
    expect(compactionCandidates(msgs, 0, 0)).toEqual([4, 6])
  })

  it('never separates a tool call from its result', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'the request' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'list_dir', arguments: {} }] },
      { role: 'tool', content: 'ok', toolCallId: 'a', toolName: 'list_dir' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'b', name: 'list_dir', arguments: {} },
          { id: 'c', name: 'list_dir', arguments: {} }
        ]
      },
      { role: 'tool', content: 'ok', toolCallId: 'b', toolName: 'list_dir' },
      // `c` never got its result before the next iteration (an interrupted call).
      { role: 'assistant', content: '', toolCalls: [{ id: 'd', name: 'list_dir', arguments: {} }] },
      { role: 'tool', content: 'ok', toolCallId: 'd', toolName: 'list_dir' },
      { role: 'assistant', content: 'done' }
    ]
    expect(compactionCandidates(msgs, 0, 0)).toEqual([3, 7])
  })

  it('offers whole turns up to the turn start, then iterations inside it', () => {
    const msgs = conversation(3) // user messages at 0, 4, 8; the last turn's iterations at 9, 11
    expect(compactionCandidates(msgs, 0, 8)).toEqual([4, 8, 11])
    expect(compactionCandidates(msgs, 4, 8)).toEqual([8, 11]) // only past the current cut
    expect(compactionCandidates(msgs, 0, -1)).toEqual([])
  })
})

describe('compactionAnchor', () => {
  it('anchors a cut inside the turn to the request that opened it', () => {
    const msgs = longTurn(3)
    expect(compactionAnchor(msgs, 3, 0)).toBe(0)
  })

  it('anchors nothing when the cut starts a whole turn', () => {
    const msgs = conversation(3)
    expect(compactionAnchor(msgs, 4, 8)).toBeUndefined()
    expect(compactionAnchor(msgs, 0, 8)).toBeUndefined()
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

  describe('with a tail budget', () => {
    it('cuts inside the current turn when its own iterations overflow the budget', () => {
      const msgs = longTurn(8) // ~5k tokens per iteration
      const budget = 12_000
      const cut = findCompactionCut(msgs, 0, 3, { tailBudget: budget })
      expect(msgs[cut].role).toBe('assistant')
      expect(estimateTokens('', msgs.slice(cut))).toBeLessThanOrEqual(budget)
      // The earliest iteration that fits: one more would not have.
      expect(estimateTokens('', msgs.slice(cut - 2))).toBeGreaterThan(budget)
    })

    it('keeps the last whole turns when they fit', () => {
      expect(findCompactionCut(conversation(5), 0, 3, { tailBudget: 1_000_000 })).toBe(8)
    })

    it('keeps fewer whole turns before it cuts inside one', () => {
      // Five turns, each carrying a ~5k-token read, then a small current request.
      const msgs: ChatMessage[] = []
      for (let t = 0; t < 5; t++) {
        msgs.push({ role: 'user', content: `q${t}` })
        msgs.push({
          role: 'assistant',
          content: '',
          toolCalls: [{ id: `c${t}`, name: 'read_file', arguments: { path: `f${t}.ts` } }]
        })
        msgs.push({ role: 'tool', content: 'x'.repeat(20_000), toolCallId: `c${t}`, toolName: 'read_file' })
        msgs.push({ role: 'assistant', content: `a${t}` })
      }
      msgs.push({ role: 'user', content: 'current question' }) // 20
      // Room for one big turn plus the request, not the classic three turns.
      const cut = findCompactionCut(msgs, 0, 3, { tailBudget: 6_000 })
      expect(cut).toBe(16)
      expect(msgs[cut].role).toBe('user')
    })

    it('keeps only the newest iteration when nothing fits', () => {
      const msgs = longTurn(4)
      expect(findCompactionCut(msgs, 0, 3, { tailBudget: 10 })).toBe(msgs.length - 2)
    })

    it('leaves the cut alone when the tail already fits', () => {
      expect(findCompactionCut(longTurn(4), 0, 3, { tailBudget: 1_000_000 })).toBe(0)
    })

    it('treats only messages up to the turn start as whole turns', () => {
      // Notes the loop pushed mid-turn are user messages, but not turns: counting them
      // would cut the request away and keep three nudges.
      const msgs: ChatMessage[] = [{ role: 'user', content: 'the request' }]
      for (let i = 0; i < 4; i++) {
        msgs.push({ role: 'assistant', content: '', toolCalls: [{ id: `n${i}`, name: 'list_dir', arguments: {} }] })
        msgs.push({ role: 'tool', content: 'x'.repeat(8_000), toolCallId: `n${i}`, toolName: 'list_dir' })
        msgs.push({ role: 'user', content: `[note ${i}]` })
      }
      const cut = findCompactionCut(msgs, 0, 3, { turnStart: 0, tailBudget: 3_000 })
      expect(msgs[cut].role).toBe('assistant')
    })
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

  it('merges adjacent user messages so the request alternates strictly', () => {
    // An anchored request in front of a head that opens on a note, and a head that
    // ends on a note in front of the instruction: both used to be two users in a row.
    const image = { mediaType: 'image/png', data: 'AAAA' }
    const prior: ChatMessage[] = [
      ...buildSummaryMessages('older summary'),
      { role: 'user', content: 'the request', images: [image] }
    ]
    const head: ChatMessage[] = [
      { role: 'user', content: '[note] keep going' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'list_dir', arguments: {} }] },
      { role: 'tool', content: 'ok', toolCallId: 'a', toolName: 'list_dir' },
      { role: 'user', content: '[note] wrap up' }
    ]
    const before = JSON.stringify([prior, head])
    const req = buildSummaryRequestMessages(prior, head)

    for (let i = 1; i < req.length; i++) {
      expect(req[i].role === 'user' && req[i - 1].role === 'user', `users at ${i - 1},${i}`).toBe(false)
    }
    expect(req[2].content).toBe('the request\n\n[note] keep going')
    expect(req[2].images).toEqual([image]) // attachments survive the merge
    expect(req.at(-1)!.content).toContain('[note] wrap up')
    expect(req.at(-1)!.content).toContain('Produce the summary now')
    expect(JSON.stringify([prior, head])).toBe(before) // inputs untouched
  })
})

describe('summaryMaxTokens', () => {
  it('gives a long session room for a full summary and a reasoning model room to think', () => {
    expect(SUMMARY_MAX_TOKENS).toBeGreaterThanOrEqual(16_000)
    expect(summaryMaxTokens(200_000)).toBe(SUMMARY_MAX_TOKENS)
    expect(summaryMaxTokens(null)).toBe(SUMMARY_MAX_TOKENS)
  })

  it('scales down for small windows, never below the old fixed cap', () => {
    expect(summaryMaxTokens(16_000)).toBe(4_000)
    expect(summaryMaxTokens(4_096)).toBe(2048)
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
    expect(stub).toBe('[earlier read_file result on src/big.ts, 12345 bytes elided; recall_history or re-run to view]')
  })

  it('omits the subject clause when there is none, and falls back to "tool"', () => {
    expect(evictionStub(undefined, '', 10)).toBe('[earlier tool result, 10 bytes elided; recall_history or re-run to view]')
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
      content: '[earlier read_file result on f0.ts, 3000 bytes elided; recall_history or re-run to view]'
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

  it('evicts a stale tool result carrying document attachments even when its text is small', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'q0' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c0', name: 'read_file', arguments: { path: 'doc.pdf' } }] },
      {
        role: 'tool',
        content: '[document attached]',
        toolCallId: 'c0',
        toolName: 'read_file',
        documents: [{ mediaType: 'application/pdf', data: 'AAAA' }]
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
    expect(stub.documents).toBeUndefined() // attachment dropped
  })

  it('returns the input unchanged when nothing is old enough to be stale', () => {
    const window = windowWithLargeToolResults(EVICT_KEEP_RECENT_TURNS)
    expect(evictStaleToolResults(window)).toBe(window)
  })

  it('ages out a single long turn\'s own early reads by iteration', () => {
    // One user turn: turn age alone never makes any of these stale.
    const msgs = longTurn(EVICT_KEEP_RECENT_ITERATIONS + 2)
    const out = evictStaleToolResults(msgs)
    const stubbed = out.filter((m) => m.role === 'tool' && m.content.startsWith('[earlier '))
    expect(stubbed.map((m) => m.toolCallId)).toEqual(['r0', 'r1'])
    // The newest iterations stay verbatim.
    expect(out.slice(-2 * EVICT_KEEP_RECENT_ITERATIONS)).toEqual(msgs.slice(-2 * EVICT_KEEP_RECENT_ITERATIONS))
  })

  it('stubs exactly what lies before an explicit boundary', () => {
    const msgs = longTurn(6)
    const out = evictStaleToolResults(msgs, { keepFrom: 3 })
    expect(out[2].content.startsWith('[earlier ')).toBe(true)
    expect(out.slice(3)).toEqual(msgs.slice(3))
    expect(evictStaleToolResults(msgs, { keepFrom: 0 })).toBe(msgs)
  })
})

describe('evictionBoundary', () => {
  it('reaches into the current turn by iteration age', () => {
    const msgs = longTurn(6) // iterations open at 1, 3, 5, 7, 9, 11
    expect(evictionBoundary(msgs)).toBe(5) // the 4th most recent iteration
  })

  it('takes whichever of turn age and iteration age reaches further', () => {
    // Five turns, one tool round each: iteration age says 5, turn age says 8.
    expect(evictionBoundary(windowWithLargeToolResults(5))).toBe(8)
    expect(evictionBoundary(windowWithLargeToolResults(5), { keepRecentIterations: 1 })).toBe(17)
  })

  it('is 0 when nothing is old enough by either measure', () => {
    expect(evictionBoundary(longTurn(EVICT_KEEP_RECENT_ITERATIONS))).toBe(0)
  })
})

describe('hasEvictableToolResults', () => {
  it('reports whether a range holds a result worth stubbing', () => {
    const msgs = longTurn(3)
    expect(hasEvictableToolResults(msgs, 0, 3)).toBe(true) // the 20k read at 2
    expect(hasEvictableToolResults(msgs, 3, 4)).toBe(false) // an assistant message
    expect(hasEvictableToolResults(msgs, 5, 5)).toBe(false) // empty range
  })

  it('skips small and already-stubbed results', () => {
    const msgs: ChatMessage[] = [
      { role: 'tool', content: 'ok', toolCallId: 'a', toolName: 'list_dir' },
      { role: 'tool', content: evictionStub('read_file', 'f.ts', 9000), toolCallId: 'b', toolName: 'read_file' }
    ]
    expect(hasEvictableToolResults(msgs, 0, 2)).toBe(false)
  })
})
