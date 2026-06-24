import { describe, it, expect } from 'vitest'
import { conversationMatches, mergeRunningTotals } from './conversations'
import type { AgentEvent, Conversation, ConversationUsage } from '@shared/agent'

const conv = (over: Partial<Conversation>): Conversation => ({
  id: 'c',
  title: 'Untitled',
  workspace: '/ws',
  providerId: 'p',
  model: 'm',
  createdAt: 0,
  updatedAt: 0,
  messages: [],
  ...over
})

describe('conversationMatches', () => {
  // The query is expected already-lowercased (searchConversations lowercases it),
  // so matching a mixed-case title is what makes search case-insensitive.
  it('matches a mixed-case title against a lowercased query', () => {
    expect(conversationMatches(conv({ title: 'Fix the Auth bug' }), 'auth')).toBe(true)
  })

  it('matches in message content', () => {
    const c = conv({ messages: [{ role: 'user', content: 'how do I parse YAML?' }] })
    expect(conversationMatches(c, 'yaml')).toBe(true)
  })

  it('returns false when nothing matches', () => {
    const c = conv({ title: 'hello', messages: [{ role: 'assistant', content: 'world' }] })
    expect(conversationMatches(c, 'zzz')).toBe(false)
  })
})

describe('mergeRunningTotals', () => {
  const usage = (over: Partial<Extract<AgentEvent, { type: 'usage' }>> = {}): AgentEvent => ({
    runId: 'r',
    type: 'usage',
    inputTokens: 10,
    outputTokens: 20,
    cost: 0.05,
    ...over
  })
  const total: ConversationUsage = { inputTokens: 100, outputTokens: 200, cost: 1.5 }

  it('rewrites a usage event with the running totals (including cost)', () => {
    const out = mergeRunningTotals(usage(), total)
    // The cost field must be carried — sending the turn's own 0.05 instead of the
    // cumulative 1.5 is the exact drift this guards against.
    expect(out).toMatchObject({ inputTokens: 100, outputTokens: 200, cost: 1.5, runId: 'r' })
  })

  it('passes non-usage events through unchanged', () => {
    const done: AgentEvent = { runId: 'r', type: 'done', stopReason: 'end_turn' }
    expect(mergeRunningTotals(done, total)).toBe(done)
  })

  it('passes the event through when there is no stored total', () => {
    const e = usage()
    expect(mergeRunningTotals(e, null)).toBe(e)
  })
})
