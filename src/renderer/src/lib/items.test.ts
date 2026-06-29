import { describe, expect, it } from 'vitest'
import { COMPACTION_SUMMARY_PREFIX, type AgentEvent, type ChatMessage } from '@shared/agent'
import {
  itemsFromMessages,
  lastUserText,
  reduceEvent,
  type DisplayItem,
  type NoticeItem,
  type QuestionItem,
  type ToolItem,
  type UserItem
} from './items'

describe('itemsFromMessages', () => {
  it('flags the compaction summary turn so it renders as markdown', () => {
    const summary = '- did a thing\n- learned a fact'
    const messages: ChatMessage[] = [
      { role: 'user', content: `${COMPACTION_SUMMARY_PREFIX}\n\n${summary}` },
      { role: 'assistant', content: 'Understood.' }
    ]
    const items = itemsFromMessages(messages)
    const user = items.find((i): i is UserItem => i.kind === 'user')
    expect(user?.isSummary).toBe(true)
  })

  it('leaves ordinary user turns unflagged', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: '- a normal message with a dash' }]
    const items = itemsFromMessages(messages)
    const user = items.find((i): i is UserItem => i.kind === 'user')
    expect(user?.isSummary).toBeUndefined()
  })

  it('rebuilds an answered ask_user call as a question card', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'q1',
            name: 'ask_user',
            arguments: { question: 'Which database?', options: ['SQLite', 'Postgres'] }
          }
        ]
      },
      { role: 'tool', toolCallId: 'q1', toolName: 'ask_user', content: 'Postgres' }
    ]
    const items = itemsFromMessages(messages)
    const q = items.find((i): i is QuestionItem => i.kind === 'question')
    expect(q).toMatchObject({
      question: 'Which database?',
      options: [{ label: 'SQLite' }, { label: 'Postgres' }],
      answer: 'Postgres'
    })
    // It must NOT also appear as a generic tool row.
    expect(items.some((i) => i.kind === 'tool' && i.id === 'q1')).toBe(false)
  })
})

describe('reduceEvent — ask_user', () => {
  const question: AgentEvent = {
    runId: 'r',
    type: 'tool_question',
    callId: 'q1',
    question: 'Pick one',
    options: [{ label: 'A' }, { label: 'B', description: 'the second' }],
    multiSelect: true
  }

  it('turns tool_question into a question item', () => {
    const items = reduceEvent([], question)
    const q = items.find((i): i is QuestionItem => i.kind === 'question')
    expect(q).toMatchObject({ id: 'q1', question: 'Pick one', multiSelect: true })
    expect(q?.options).toHaveLength(2)
  })

  it('does not render ask_user as a tool row on tool_start', () => {
    const items = reduceEvent([], {
      runId: 'r',
      type: 'tool_start',
      callId: 'q1',
      name: 'ask_user',
      args: {}
    })
    expect(items).toHaveLength(0)
  })

  it('folds the ask_user result into the question card as the answer', () => {
    let items = reduceEvent([], question)
    items = reduceEvent(items, {
      runId: 'r',
      type: 'tool_result',
      callId: 'q1',
      name: 'ask_user',
      ok: true,
      output: 'A'
    })
    const q = items.find((i): i is QuestionItem => i.kind === 'question')
    expect(q?.answer).toBe('A')
  })
})

describe('reduceEvent — prompt replay on re-adopt (upsert by callId)', () => {
  it('flips an existing tool row to awaiting-approval instead of duplicating it', () => {
    // A run parked on an approval: the call is first rebuilt from the persisted log
    // as a tool row, then its approval prompt is replayed when re-adopted.
    const fromLog = itemsFromMessages([
      {
        role: 'assistant',
        content: 'writing',
        toolCalls: [{ id: 'w1', name: 'write_file', arguments: { path: 'a.txt' } }]
      }
    ])
    const items = reduceEvent(fromLog, {
      runId: 'r',
      type: 'tool_approval',
      callId: 'w1',
      name: 'write_file',
      summary: 'write a.txt',
      kind: 'write'
    })
    const tools = items.filter((i): i is ToolItem => i.kind === 'tool' && i.id === 'w1')
    expect(tools).toHaveLength(1)
    expect(tools[0].status).toBe('awaiting-approval')
    expect(tools[0].summary).toBe('write a.txt')
  })

  it('appends an approval row when no row exists yet (the normal live first emit)', () => {
    const items = reduceEvent([], {
      runId: 'r',
      type: 'tool_approval',
      callId: 'w1',
      name: 'write_file',
      summary: 's',
      kind: 'write'
    })
    const tools = items.filter((i): i is ToolItem => i.kind === 'tool')
    expect(tools).toHaveLength(1)
    expect(tools[0].status).toBe('awaiting-approval')
  })

  it('updates an existing question card instead of duplicating it', () => {
    const fromLog = itemsFromMessages([
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'q1', name: 'ask_user', arguments: { question: 'Which?', options: ['A', 'B'] } }
        ]
      }
    ])
    const items = reduceEvent(fromLog, {
      runId: 'r',
      type: 'tool_question',
      callId: 'q1',
      question: 'Which?',
      options: [{ label: 'A' }, { label: 'B' }]
    })
    const questions = items.filter((i): i is QuestionItem => i.kind === 'question' && i.id === 'q1')
    expect(questions).toHaveLength(1)
  })
})

describe('PR lifecycle notices', () => {
  it('appends a created-PR notice after a gh_pr_create result (live)', () => {
    let items = reduceEvent([], {
      runId: 'r',
      type: 'tool_start',
      callId: 'p1',
      name: 'gh_pr_create',
      args: { title: 'x' }
    })
    items = reduceEvent(items, {
      runId: 'r',
      type: 'tool_result',
      callId: 'p1',
      name: 'gh_pr_create',
      ok: true,
      output: 'https://github.com/acme/houston/pull/42'
    })
    const tool = items.find((i): i is ToolItem => i.kind === 'tool')
    expect(tool?.status).toBe('done')
    const notice = items.find((i): i is NoticeItem => i.kind === 'notice')
    expect(notice?.text).toContain('Opened pull request #42')
  })

  it('does not add a notice for an ordinary tool result', () => {
    const items = reduceEvent(
      [{ kind: 'tool', id: 'r1', name: 'read_file', status: 'running' }],
      { runId: 'r', type: 'tool_result', callId: 'r1', name: 'read_file', ok: true, output: 'hi' }
    )
    expect(items.some((i) => i.kind === 'notice')).toBe(false)
  })

  it('rebuilds created + merged notices from the saved log', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'p1', name: 'gh_pr_create', arguments: { title: 'x' } }]
      },
      { role: 'tool', toolCallId: 'p1', toolName: 'gh_pr_create', content: 'https://x/pull/9' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'p2', name: 'gh_pr_view', arguments: { number: 9 } }]
      },
      {
        role: 'tool',
        toolCallId: 'p2',
        toolName: 'gh_pr_view',
        content: '#9 Title [merged]\nfeat → main\nhttps://x/pull/9'
      }
    ]
    const notices = itemsFromMessages(messages).filter((i): i is NoticeItem => i.kind === 'notice')
    expect(notices.map((n) => n.text)).toEqual([
      expect.stringContaining('Opened pull request #9'),
      expect.stringContaining('Pull request #9 merged')
    ])
  })
})

describe('lastUserText', () => {
  const user = (id: string, text: string, isSummary = false): DisplayItem => ({
    kind: 'user',
    id,
    text,
    ...(isSummary ? { isSummary: true } : {})
  })

  it('returns the most recent user turn', () => {
    const items: DisplayItem[] = [
      user('u1', 'first'),
      { kind: 'assistant', id: 'a1', text: 'reply', streaming: false },
      user('u2', 'second')
    ]
    expect(lastUserText(items)).toBe('second')
  })

  it('skips the synthetic compaction-summary turn', () => {
    const items: DisplayItem[] = [user('u1', 'real message'), user('s1', 'summary blob', true)]
    expect(lastUserText(items)).toBe('real message')
  })

  it('returns undefined when there is no user turn', () => {
    expect(lastUserText([])).toBeUndefined()
    expect(
      lastUserText([{ kind: 'assistant', id: 'a1', text: 'hi', streaming: false }])
    ).toBeUndefined()
  })
})

describe('reduceEvent tool progress', () => {
  const ev = (e: AgentEvent): AgentEvent => e

  it('attaches a progress line to a running tool and clears it on the result', () => {
    let items: DisplayItem[] = []
    items = reduceEvent(
      items,
      ev({ runId: 'r1', type: 'tool_start', callId: 'c1', name: 'review_changes', args: {} })
    )
    items = reduceEvent(
      items,
      ev({ runId: 'r1', type: 'tool_progress', callId: 'c1', message: 'Reviewing correctness…' })
    )
    const running = items.find((it): it is ToolItem => it.kind === 'tool' && it.id === 'c1')!
    expect(running.status).toBe('running')
    expect(running.progress).toContain('Reviewing')

    items = reduceEvent(
      items,
      ev({ runId: 'r1', type: 'tool_result', callId: 'c1', name: 'review_changes', ok: true, output: 'done' })
    )
    const done = items.find((it): it is ToolItem => it.kind === 'tool' && it.id === 'c1')!
    expect(done.status).toBe('done')
    expect(done.progress).toBeUndefined()
  })

  it('ignores progress for a tool that is not present', () => {
    const items = reduceEvent([], ev({ runId: 'r1', type: 'tool_progress', callId: 'missing', message: 'x' }))
    expect(items).toEqual([])
  })
})

describe('reduceEvent subagent rows', () => {
  const ev = (e: AgentEvent): AgentEvent => e
  const start = (): DisplayItem[] =>
    reduceEvent([], ev({ runId: 'r1', type: 'tool_start', callId: 'c1', name: 'review_changes', args: {} }))
  const sub = (id: string, label: string, status: 'running' | 'done' | 'error'): AgentEvent =>
    ev({ runId: 'r1', type: 'subagent', parentCallId: 'c1', id, label, status })
  const toolC1 = (items: DisplayItem[]): ToolItem =>
    items.find((it): it is ToolItem => it.kind === 'tool' && it.id === 'c1')!

  it('adds a child row on start and updates it in place by id', () => {
    let items = start()
    items = reduceEvent(items, sub('correctness', 'Correctness', 'running'))
    expect(toolC1(items).subagents).toEqual([{ id: 'correctness', label: 'Correctness', status: 'running' }])

    items = reduceEvent(items, sub('correctness', 'Correctness — 2 issues', 'done'))
    // Same id updates the existing row — no duplicate; label + status reflect the outcome.
    expect(toolC1(items).subagents).toEqual([
      { id: 'correctness', label: 'Correctness — 2 issues', status: 'done' }
    ])
  })

  it('keeps one row per distinct subagent id, in arrival order', () => {
    let items = start()
    for (const id of ['correctness', 'security', 'quality']) items = reduceEvent(items, sub(id, id, 'running'))
    expect(toolC1(items).subagents?.map((s) => s.id)).toEqual(['correctness', 'security', 'quality'])
  })

  it('finalizes any still-running child rows when the tool result arrives', () => {
    let items = start()
    items = reduceEvent(items, sub('quality', 'Quality', 'running'))
    items = reduceEvent(
      items,
      ev({ runId: 'r1', type: 'tool_result', callId: 'c1', name: 'review_changes', ok: true, output: 'done' })
    )
    const tool = toolC1(items)
    expect(tool.status).toBe('done')
    expect(tool.subagents).toEqual([{ id: 'quality', label: 'Quality', status: 'done' }])
  })

  it('ignores a subagent event for a parent tool that is not present', () => {
    const items = reduceEvent([], sub('correctness', 'Correctness', 'running'))
    expect(items).toEqual([])
  })
})
