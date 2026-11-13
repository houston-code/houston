import { describe, expect, it } from 'vitest'
import type { DisplayItem, ToolItem } from './items'
import { currentTodos, showPinnedTodos } from './currentTodos'

const write = (todos: unknown, status: ToolItem['status'] = 'done'): DisplayItem =>
  ({ kind: 'tool', id: Math.random().toString(), name: 'todo_write', args: { todos }, status }) as ToolItem

describe('currentTodos', () => {
  it('takes the last todo_write that went through', () => {
    const items = [
      write([{ content: 'a', status: 'completed' }]),
      write([{ content: 'b', status: 'in_progress' }]),
      write([{ content: 'denied', status: 'pending' }], 'denied'),
      write([{ content: 'running', status: 'pending' }], 'running')
    ]
    expect(currentTodos(items)).toEqual([{ content: 'b', status: 'in_progress' }])
  })

  it('is empty with no list, a cleared list, or a malformed one', () => {
    expect(currentTodos([])).toEqual([])
    expect(currentTodos([write([{ content: 'a', status: 'pending' }]), write([])])).toEqual([])
    expect(currentTodos([write('nope')])).toEqual([])
  })
})

describe('showPinnedTodos', () => {
  const done = [{ content: 'a', status: 'completed' as const }]
  const left = [...done, { content: 'b', status: 'pending' as const }]
  it('shows while running or while work is left, never for an empty list', () => {
    expect(showPinnedTodos(done, true)).toBe(true)
    expect(showPinnedTodos(done, false)).toBe(false)
    expect(showPinnedTodos(left, false)).toBe(true)
    expect(showPinnedTodos([], true)).toBe(false)
  })
})
