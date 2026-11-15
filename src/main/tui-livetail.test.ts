import { describe, expect, it } from 'vitest'
import { LiveTail } from './tui-livetail'
import { latestTodos, todoProgress } from './tui-todos'
import type { ChatMessage } from '@shared/agent'

describe('LiveTail', () => {
  it('returns each complete line once as the tail grows', () => {
    const t = new LiveTail()
    expect(t.next('c', 'one\ntw')).toEqual(['one'])
    expect(t.next('c', 'one\ntwo\nthree\n')).toEqual(['two', 'three'])
    expect(t.next('c', 'one\ntwo\nthree\n')).toEqual([])
    expect(t.streamed('c')).toBe(true)
  })

  it('follows a window that slides, even when its first line is cut', () => {
    const t = new LiveTail()
    expect(t.next('c', 'aaaa\nbbbb\ncccc\n')).toEqual(['aaaa', 'bbbb', 'cccc'])
    // The bounded tail dropped "aaaa" and the start of "bbbb".
    expect(t.next('c', 'bb\ncccc\ndddd\n')).toEqual(['dddd'])
  })

  it('prints everything after a gap longer than the window', () => {
    const t = new LiveTail()
    t.next('c', 'a\nb\n')
    expect(t.next('c', 'x\ny\n')).toEqual(['x', 'y'])
  })

  it('keeps repeated lines straight', () => {
    const t = new LiveTail()
    expect(t.next('c', '.\n.\n')).toEqual(['.', '.'])
    expect(t.next('c', '.\n.\n.\n')).toEqual(['.'])
  })

  it('tracks calls apart, and forgets one', () => {
    const t = new LiveTail()
    t.next('a', 'x\n')
    expect(t.next('b', 'x\n')).toEqual(['x'])
    t.forget('a')
    expect(t.streamed('a')).toBe(false)
    expect(t.streamed('b')).toBe(true)
    expect(t.streamed('never')).toBe(false)
  })
})

describe('latestTodos', () => {
  const write = (todos: unknown): ChatMessage => ({
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'c', name: 'todo_write', arguments: { todos } }]
  })

  it('reads the latest todo_write call', () => {
    const msgs: ChatMessage[] = [
      write([{ content: 'old', status: 'pending' }]),
      { role: 'tool', content: 'ok', toolCallId: 'c', toolName: 'todo_write' },
      write([
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'in_progress' }
      ]),
      { role: 'assistant', content: 'working on b' }
    ]
    expect(latestTodos(msgs)?.map((t) => t.content)).toEqual(['a', 'b'])
    expect(todoProgress(latestTodos(msgs) ?? [])).toBe('1 of 2 done')
  })

  it('is null with no list, and empty for a cleared one', () => {
    expect(latestTodos([{ role: 'user', content: 'hi' }])).toBeNull()
    expect(latestTodos([write([])])).toEqual([])
  })
})
