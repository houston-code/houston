import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_SUBAGENT_SESSIONS,
  getSubAgent,
  rememberSubAgent,
  resetSubAgentSessions,
  updateSubAgentMessages
} from './subagentSessions'
import type { ChatMessage } from '@shared/agent'

const msgs = (text: string): ChatMessage[] => [{ role: 'user', content: text }]

afterEach(() => resetSubAgentSessions())

describe('subagent session registry', () => {
  it('stores a transcript and hands back a monotonic per-conversation id', () => {
    expect(rememberSubAgent('conv-a', { messages: msgs('one'), writable: false, model: 'm' })).toBe('ag1')
    expect(rememberSubAgent('conv-a', { messages: msgs('two'), writable: true, model: 'm' })).toBe('ag2')
    // Ids are scoped per conversation, so another chat starts back at ag1.
    expect(rememberSubAgent('conv-b', { messages: msgs('other'), writable: false, model: 'm' })).toBe('ag1')

    const stored = getSubAgent('conv-a', 'ag1')
    expect(stored?.messages[0].content).toBe('one')
    expect(stored?.writable).toBe(false)
    // Lookups don't leak across conversations.
    expect(getSubAgent('conv-b', 'ag2')).toBeUndefined()
  })

  it('returns undefined for an unknown id', () => {
    expect(getSubAgent('conv-a', 'ag1')).toBeUndefined()
  })

  it('replaces a resumed transcript in place, keeping the id', () => {
    const id = rememberSubAgent('conv-a', { messages: msgs('v1'), writable: false, model: 'm' })
    updateSubAgentMessages('conv-a', id, msgs('v2'))
    expect(getSubAgent('conv-a', id)?.messages[0].content).toBe('v2')
  })

  it('evicts the oldest transcript past the cap, but never reuses ids', () => {
    const ids: string[] = []
    for (let i = 0; i < MAX_SUBAGENT_SESSIONS + 2; i++) {
      ids.push(rememberSubAgent('conv-a', { messages: msgs(`t${i}`), writable: false, model: 'm' }))
    }
    // The two oldest fell out; the newest are intact; the counter never rewound.
    expect(getSubAgent('conv-a', ids[0])).toBeUndefined()
    expect(getSubAgent('conv-a', ids[1])).toBeUndefined()
    expect(getSubAgent('conv-a', ids.at(-1)!)?.messages[0].content).toBe(`t${MAX_SUBAGENT_SESSIONS + 1}`)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('an updated transcript re-enters the eviction order as most recent', () => {
    const first = rememberSubAgent('conv-a', { messages: msgs('keep'), writable: false, model: 'm' })
    for (let i = 0; i < MAX_SUBAGENT_SESSIONS - 1; i++) {
      rememberSubAgent('conv-a', { messages: msgs(`filler${i}`), writable: false, model: 'm' })
    }
    // Touch the first entry, then overflow by one: the oldest *untouched* entry
    // (filler0) should be evicted, not the freshly updated first.
    updateSubAgentMessages('conv-a', first, msgs('kept'))
    rememberSubAgent('conv-a', { messages: msgs('overflow'), writable: false, model: 'm' })
    expect(getSubAgent('conv-a', first)?.messages[0].content).toBe('kept')
    expect(getSubAgent('conv-a', 'ag2')).toBeUndefined()
  })
})
