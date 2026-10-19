import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CHILD_REPORT_SUMMARY_CHARS,
  MAX_PENDING_CHILD_REPORTS,
  addUsage,
  childReportFrom,
  conversationMatches,
  createConversation,
  forkConversation,
  listConversations,
  reportChildToParent,
  setProposalState,
  takeChildReports,
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

  it('titles a first-party prompt by what the user did, not the instructions', () => {
    expect(
      deriveTitle([
        {
          role: 'user',
          content: 'Review my current uncommitted changes for correctness…',
          invokedAs: { kind: 'command', label: '/review', typed: '/review auth' }
        }
      ])
    ).toBe('/review auth')
    expect(
      deriveTitle([
        { role: 'user', content: 'Create a GitHub pull request…', invokedAs: { kind: 'action', label: 'Create PR' } }
      ])
    ).toBe('Create PR')
  })

  it('titles a handed-off brief from its text, which is the task itself', () => {
    expect(
      deriveTitle([
        { role: 'user', content: 'Add OAuth login', invokedAs: { kind: 'spawned', label: 'Handed-off task' } }
      ])
    ).toBe('Add OAuth login')
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

  it('carries the running cache-read and per-model breakdown too', () => {
    const withDetail: ConversationUsage = {
      inputTokens: 100,
      outputTokens: 200,
      cost: 1.5,
      cacheReadTokens: 800,
      perModel: [
        { model: 'claude', inputTokens: 90, outputTokens: 180, cost: 1.4, cacheReadTokens: 800, cacheWriteTokens: 0 }
      ]
    }
    const out = mergeRunningTotals(usage(), withDetail)
    expect(out).toMatchObject({ cacheReadTokens: 800 })
    expect((out as Extract<AgentEvent, { type: 'usage' }>).perModel).toHaveLength(1)
  })
})

describe('addUsage — persisted per-model + cache breakdown', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'houston-conv-'))
    setUserDataDir(dir)
  })
  afterEach(() => {
    resetUserDataDir()
    rmSync(dir, { recursive: true, force: true })
  })

  it('accumulates per model and the cache split across turns, and persists them', () => {
    const c = createConversation({ workspace: '/ws', providerId: 'p', model: 'm' })
    addUsage(c.id, { inputTokens: 100, outputTokens: 50, cost: 0.01, model: 'claude', cacheReadTokens: 800 })
    addUsage(c.id, { inputTokens: 120, outputTokens: 30, cost: 0.02, model: 'haiku' }) // a cheaper subagent model
    const total = addUsage(c.id, { inputTokens: 130, outputTokens: 20, cost: 0.01, model: 'claude', cacheReadTokens: 200 })

    // Aggregate: output sums, cost sums, context is the latest turn, cache sums.
    expect(total).toMatchObject({ outputTokens: 100, cost: 0.04, inputTokens: 130, cacheReadTokens: 1000 })
    // Per model, in first-seen order.
    expect(total?.perModel?.map((m) => m.model)).toEqual(['claude', 'haiku'])
    expect(total?.perModel?.[0]).toMatchObject({ cost: 0.02, cacheReadTokens: 1000 })

    // Persisted — the breakdown survives a reload (the "resets on restart" fix).
    expect(getConversation(c.id)?.usage?.perModel?.[1].model).toBe('haiku')
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

describe('childReportFrom', () => {
  it('summarizes the last written answer, flattened', () => {
    const c = conv({
      id: 'child',
      title: 'Docs',
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: 'Updated the\n\n  API docs.' },
        { role: 'assistant', content: '' }
      ]
    })
    expect(childReportFrom(c, 7)).toEqual({
      conversationId: 'child',
      title: 'Docs',
      outcome: 'done',
      summary: 'Updated the API docs.',
      finishedAt: 7
    })
  })

  it('reports a failed run by its error, and truncates a long summary', () => {
    const failed = childReportFrom(conv({ lastError: { message: 'Rate limited' } }), 0)
    expect(failed).toMatchObject({ outcome: 'error', summary: 'Rate limited' })
    const long = childReportFrom(conv({ messages: [{ role: 'assistant', content: 'x'.repeat(1000) }] }), 0)
    expect(long.summary).toHaveLength(CHILD_REPORT_SUMMARY_CHARS)
    expect(long.summary.endsWith('…')).toBe(true)
  })

  it('says so when the child never wrote an answer', () => {
    expect(childReportFrom(conv({}), 0).summary).toMatch(/without a written answer/)
  })
})

describe('proposals and child reports (persisted)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'houston-conv-'))
    setUserDataDir(dir)
  })
  afterEach(() => {
    resetUserDataDir()
    rmSync(dir, { recursive: true, force: true })
  })

  it('records a proposal decision without reordering the chat', () => {
    const c = createConversation({ workspace: '/ws', providerId: 'p', model: 'm' })
    const before = getConversation(c.id)!.updatedAt
    const map = setProposalState(c.id, 'call-1', { status: 'dismissed', at: 5 })
    expect(map).toEqual({ 'call-1': { status: 'dismissed', at: 5 } })
    setProposalState(c.id, 'call-2', { status: 'started', conversationId: 'x', at: 6 })
    const after = getConversation(c.id)!
    expect(Object.keys(after.proposals ?? {})).toEqual(['call-1', 'call-2'])
    expect(after.updatedAt).toBe(before)
    expect(setProposalState('missing-id', 'c', { status: 'here', at: 1 })).toEqual({})
  })

  it('queues a finished child on its parent, once per child, and hands it over exactly once', () => {
    const parent = createConversation({ workspace: '/ws', providerId: 'p', model: 'm' })
    const child = createConversation({ workspace: '/ws', providerId: 'p', model: 'm' })
    setMessages(child.id, [
      { role: 'user', content: 'do it' },
      { role: 'assistant', content: 'first answer' }
    ])
    reportChildToParent(parent.id, child.id)
    setMessages(child.id, [
      { role: 'user', content: 'do it' },
      { role: 'assistant', content: 'second answer' }
    ])
    reportChildToParent(parent.id, child.id)
    const taken = takeChildReports(parent.id)
    expect(taken).toHaveLength(1)
    expect(taken[0]).toMatchObject({ conversationId: child.id, summary: 'second answer' })
    expect(takeChildReports(parent.id)).toEqual([])
    expect(getConversation(parent.id)!.childReports).toBeUndefined()
  })

  it('caps the pending reports, dropping the oldest', () => {
    const parent = createConversation({ workspace: '/ws', providerId: 'p', model: 'm' })
    const ids: string[] = []
    for (let i = 0; i < MAX_PENDING_CHILD_REPORTS + 2; i++) {
      const c = createConversation({ workspace: '/ws', providerId: 'p', model: 'm' })
      ids.push(c.id)
      reportChildToParent(parent.id, c.id)
    }
    const taken = takeChildReports(parent.id)
    expect(taken).toHaveLength(MAX_PENDING_CHILD_REPORTS)
    expect(taken[0].conversationId).toBe(ids[2])
  })

  it('ignores a report when either chat is gone', () => {
    const parent = createConversation({ workspace: '/ws', providerId: 'p', model: 'm' })
    reportChildToParent(parent.id, 'missing-child')
    reportChildToParent('missing-parent', parent.id)
    expect(takeChildReports(parent.id)).toEqual([])
  })

  it('keeps proposals and reports out of the sidebar list, and a fork never inherits reports', () => {
    const parent = createConversation({ workspace: '/ws', providerId: 'p', model: 'm' })
    const child = createConversation({ workspace: '/ws', providerId: 'p', model: 'm' })
    setProposalState(parent.id, 'call-1', { status: 'dismissed', at: 1 })
    reportChildToParent(parent.id, child.id)
    const meta = listConversations().find((m) => m.id === parent.id) as unknown as Record<string, unknown>
    expect(meta.proposals).toBeUndefined()
    expect(meta.childReports).toBeUndefined()
    const fork = forkConversation(parent.id)!
    expect(fork.childReports).toBeUndefined()
    expect(fork.proposals).toEqual({ 'call-1': { status: 'dismissed', at: 1 } })
  })
})
