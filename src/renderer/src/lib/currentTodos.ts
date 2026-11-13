import { parseTodosSafe, type Todo } from '@shared/todos'
import type { DisplayItem } from './items'

/**
 * The chat's current todo list: the last `todo_write` that went through (a denied or
 * failed one changed nothing). Empty when the agent cleared it or never wrote one.
 */
export function currentTodos(items: readonly DisplayItem[]): Todo[] {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it.kind === 'tool' && it.name === 'todo_write' && it.status === 'done') return parseTodosSafe(it.args?.todos)
  }
  return []
}

/** Whether the pinned card shows: a list exists, and the turn is running or work is left. */
export function showPinnedTodos(todos: readonly Todo[], running: boolean): boolean {
  return todos.length > 0 && (running || todos.some((t) => t.status !== 'completed'))
}
