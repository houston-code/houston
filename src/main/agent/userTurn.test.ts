import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/agent'
import { appendUserTurn } from './userTurn'

const user = (content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ role: 'user', content, ...extra })
const img = { mediaType: 'image/png', data: 'aGk=' } as unknown as NonNullable<ChatMessage['images']>[number]

describe('appendUserTurn', () => {
  it('appends after an answered turn', () => {
    const history: ChatMessage[] = [user('hi'), { role: 'assistant', content: 'hello' }]
    expect(appendUserTurn(history, user('hi'))).toEqual([...history, user('hi')])
  })

  it('replaces an identical message whose turn got no answer, instead of repeating it', () => {
    const history: ChatMessage[] = [user('first'), { role: 'assistant', content: 'ok' }, user('start the dev server')]
    expect(appendUserTurn(history, user('start the dev server'))).toEqual(history)
  })

  it('keeps the record of why the replaced message got no answer', () => {
    const failed = { reason: 'error' as const, message: 'overloaded', at: '2026-10-22T00:00:00.000Z' }
    const history: ChatMessage[] = [user('start the dev server', { unanswered: [failed] })]
    expect(appendUserTurn(history, user('start the dev server'))).toEqual([
      user('start the dev server', { unanswered: [failed] })
    ])
    // A different message leaves the record where it was.
    expect(appendUserTurn(history, user('use port 4000'))).toEqual([...history, user('use port 4000')])
  })

  it('appends a different message after an unanswered one', () => {
    const history: ChatMessage[] = [user('start the dev server')]
    expect(appendUserTurn(history, user('use port 4000'))).toEqual([...history, user('use port 4000')])
  })

  it('treats different attachments or a different invocation as a different message', () => {
    expect(appendUserTurn([user('look')], user('look', { images: [img] }))).toHaveLength(2)
    expect(appendUserTurn([user('look', { images: [img] })], user('look'))).toHaveLength(2)
    const review = user('Review the diff', { invokedAs: { kind: 'command', label: '/review' } as ChatMessage['invokedAs'] })
    expect(appendUserTurn([user('Review the diff')], review)).toHaveLength(2)
    expect(appendUserTurn([review], { ...review })).toHaveLength(1)
  })

  it('never folds into a trailing tool result or assistant message', () => {
    const tool: ChatMessage = { role: 'tool', content: 'x', toolCallId: 't1', toolName: 'read_file' }
    expect(appendUserTurn([tool], user('x'))).toHaveLength(2)
  })

  it('starts an empty history', () => {
    expect(appendUserTurn([], user('hi'))).toEqual([user('hi')])
  })
})
