import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  conversationMatches,
  createConversation,
  deriveTitle,
  getConversation,
  mergeRunningTotals,
  needsGeneratedTitle,
  organizeConversation,
  setMessages
} from './conversations'
import { setUserDataDir, resetUserDataDir } from './userData'
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

describe('needsGeneratedTitle', () => {
  const userMsg = { role: 'user', content: 'hello' } as const

  it('is eligible for a fresh chat that has a user message', () => {
    expect(needsGeneratedTitle(conv({ messages: [userMsg] }))).toBe(true)
  })

  it('is not eligible before any user message exists', () => {
    expect(needsGeneratedTitle(conv({ messages: [] }))).toBe(false)
    expect(needsGeneratedTitle(conv({ messages: [{ role: 'assistant', content: 'hi' }] }))).toBe(
      false
    )
  })

  it('never re-titles a chat the user has manually renamed', () => {
    expect(needsGeneratedTitle(conv({ messages: [userMsg], titleCustom: true }))).toBe(false)
  })

  it('generates at most once (skips when a title was already generated)', () => {
    expect(needsGeneratedTitle(conv({ messages: [userMsg], titleGenerated: true }))).toBe(false)
  })
})

describe('deriveTitle', () => {
  it('derives from the first user message, truncating long text', () => {
    expect(deriveTitle([{ role: 'user', content: 'Fix the auth bug' }])).toBe('Fix the auth bug')
    const long = 'x'.repeat(80)
    expect(deriveTitle([{ role: 'user', content: long }])).toBe(`${'x'.repeat(57)}…`)
  })

  it('redacts a token-shaped secret so it never lands in the (persisted) title', () => {
    const title = deriveTitle([{ role: 'user', content: 'my key is ghp_' + 'A'.repeat(36) }])
    expect(title).toBe('my key is [redacted:github-token]')
  })

  it('leaves ordinary prose untouched', () => {
    expect(deriveTitle([{ role: 'user', content: 'my password is blah' }])).toBe('my password is blah')
  })

  it('returns null when there is no user message', () => {
    expect(deriveTitle([{ role: 'assistant', content: 'hi' }])).toBeNull()
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

describe('setMessages title handling', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'houston-conv-'))
    setUserDataDir(dir)
  })
  afterEach(() => {
    resetUserDataDir()
    rmSync(dir, { recursive: true, force: true })
  })

  it('does not clobber a user rename to the literal "New chat"', () => {
    const c = createConversation({ workspace: '/ws', providerId: 'p', model: 'm' })
    // A deliberate rename to "New chat" sets titleCustom; setMessages must not re-derive.
    organizeConversation(c.id, { title: 'New chat' })
    setMessages(c.id, [{ role: 'user', content: 'Fix the auth bug' }])
    expect(getConversation(c.id)?.title).toBe('New chat')
  })

  it('still auto-derives a title over the placeholder for a non-custom chat', () => {
    const c = createConversation({ workspace: '/ws', providerId: 'p', model: 'm' })
    setMessages(c.id, [{ role: 'user', content: 'Fix the auth bug' }])
    expect(getConversation(c.id)?.title).toBe('Fix the auth bug')
  })
})
