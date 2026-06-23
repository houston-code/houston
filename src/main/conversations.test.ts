import { describe, it, expect } from 'vitest'
import { conversationMatches } from './conversations'
import type { Conversation } from '@shared/agent'

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
