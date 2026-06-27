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
