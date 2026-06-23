import { describe, expect, it } from 'vitest'
import {
  formatTodoList,
  formatTodoSummary,
  parseTodos,
  parseTodosSafe,
  type Todo
} from './todos'

describe('parseTodos', () => {
  it('accepts a well-formed list', () => {
    const todos = parseTodos([
      { content: 'a', status: 'pending' },
      { content: 'b', status: 'completed' }
    ])
    expect(todos).toEqual([
      { content: 'a', status: 'pending' },
      { content: 'b', status: 'completed' }
    ])
  })

  it('trims content', () => {
    expect(parseTodos([{ content: '  spaced  ', status: 'pending' }])[0].content).toBe('spaced')
  })

  it('throws when not an array', () => {
    expect(() => parseTodos('nope')).toThrow(/must be an array/)
  })

  it('throws on empty content', () => {
    expect(() => parseTodos([{ content: '   ', status: 'pending' }])).toThrow(/non-empty/)
  })

  it('throws on an unknown status', () => {
    expect(() => parseTodos([{ content: 'x', status: 'done' }])).toThrow(/status must be one of/)
  })

  it('throws on a non-object item', () => {
    expect(() => parseTodos(['x'])).toThrow(/must be an object/)
  })
})

describe('parseTodosSafe', () => {
  it('returns [] on bad input instead of throwing', () => {
    expect(parseTodosSafe('nope')).toEqual([])
    expect(parseTodosSafe(undefined)).toEqual([])
    expect(parseTodosSafe([{ content: '', status: 'pending' }])).toEqual([])
  })

  it('returns the parsed list on good input', () => {
    expect(parseTodosSafe([{ content: 'a', status: 'pending' }])).toHaveLength(1)
  })
})

describe('formatTodoSummary', () => {
  it('reports counts', () => {
    const todos: Todo[] = [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' },
      { content: 'c', status: 'pending' }
    ]
    expect(formatTodoSummary(todos)).toBe('Updated todo list: 3 items (1 completed, 1 in progress).')
  })

  it('handles the empty list', () => {
    expect(formatTodoSummary([])).toBe('Cleared the todo list.')
  })

  it('uses the singular for one item', () => {
    expect(formatTodoSummary([{ content: 'a', status: 'pending' }])).toContain('1 item (')
  })
})

describe('formatTodoList', () => {
  it('renders status markers per line', () => {
    const out = formatTodoList([
      { content: 'a', status: 'pending' },
      { content: 'b', status: 'in_progress' },
      { content: 'c', status: 'completed' }
    ])
    expect(out).toBe('[ ] a\n[~] b\n[x] c')
  })
})
