import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/agent'
import {
  COMPACTION_SUMMARY_PREFIX,
  buildSummaryMessages,
  buildSummaryRequestMessages,
  estimateTokens,
  findCompactionCut
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
