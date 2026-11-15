import type { ChatMessage } from '@shared/agent'
import { parseTodosSafe, type Todo } from '@shared/todos'

/**
 * `/todos`: the agent's current todo list, which the desktop keeps pinned above the
 * message box and the terminal prints only when it changes (so it scrolls away).
 */

/**
 * The list from the chat's latest `todo_write` call, or null when the agent never
 * wrote one. An empty list is a list the agent cleared.
 */
export function latestTodos(messages: readonly ChatMessage[]): Todo[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const calls = messages[i].role === 'assistant' ? (messages[i].toolCalls ?? []) : []
    for (let j = calls.length - 1; j >= 0; j--) {
      if (calls[j].name === 'todo_write') return parseTodosSafe(calls[j].arguments?.todos)
    }
  }
  return null
}

/** "2 of 5 done", for the line under the list. */
export function todoProgress(todos: readonly Todo[]): string {
  const done = todos.filter((t) => t.status === 'completed').length
  return `${done} of ${todos.length} done`
}
