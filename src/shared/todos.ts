/**
 * The agent's task-list scratchpad. The `todo_write` tool records the full list
 * each time; the main process validates it and the renderer draws it as a
 * checklist. Pure helpers live here so both processes share one definition.
 */

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface Todo {
  content: string
  status: TodoStatus
}

export const TODO_STATUSES: TodoStatus[] = ['pending', 'in_progress', 'completed']

/**
 * Validate and normalize a raw `todos` value (as received in tool arguments) into
 * a `Todo[]`. Throws a descriptive error on malformed input so the agent gets a
 * useful tool result and can correct itself.
 */
export function parseTodos(value: unknown): Todo[] {
  if (!Array.isArray(value)) throw new Error('todos must be an array.')
  return value.map((raw, i) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error(`todos[${i}] must be an object with "content" and "status".`)
    }
    const { content, status } = raw as { content?: unknown; status?: unknown }
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error(`todos[${i}].content must be a non-empty string.`)
    }
    if (typeof status !== 'string' || !TODO_STATUSES.includes(status as TodoStatus)) {
      throw new Error(`todos[${i}].status must be one of: ${TODO_STATUSES.join(', ')}.`)
    }
    return { content: content.trim(), status: status as TodoStatus }
  })
}

/** Best-effort parse for display code that must not throw. Returns [] on bad input. */
export function parseTodosSafe(value: unknown): Todo[] {
  try {
    return parseTodos(value)
  } catch {
    return []
  }
}

/** A short one-line summary for the model-facing tool result and approval text. */
export function formatTodoSummary(todos: Todo[]): string {
  if (todos.length === 0) return 'Cleared the todo list.'
  const done = todos.filter((t) => t.status === 'completed').length
  const active = todos.filter((t) => t.status === 'in_progress').length
  return `Updated todo list: ${todos.length} item${todos.length === 1 ? '' : 's'} (${done} completed, ${active} in progress).`
}

const MARK: Record<TodoStatus, string> = { pending: '[ ]', in_progress: '[~]', completed: '[x]' }

/** Render the list as plain text (included in the model-facing tool result). */
export function formatTodoList(todos: Todo[]): string {
  return todos.map((t) => `${MARK[t.status]} ${t.content}`).join('\n')
}
