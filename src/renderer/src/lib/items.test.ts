import { describe, expect, it } from 'vitest'
import { COMPACTION_SUMMARY_PREFIX, type AgentEvent, type ChatMessage } from '@shared/agent'
import { itemsFromMessages, reduceEvent, type QuestionItem, type UserItem } from './items'

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
