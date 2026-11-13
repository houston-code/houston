import { useState } from 'react'
import type { Todo } from '@shared/todos'

const MARK: Record<Todo['status'], string> = { pending: '○', in_progress: '◐', completed: '●' }

/**
 * The chat's current todo list, pinned above the message box while a turn runs or
 * work on it is left. Collapsed it shows progress and the item in progress; expanded,
 * the whole list. The transcript keeps its inline copies.
 */
export function PinnedTodos({ todos }: { todos: readonly Todo[] }): JSX.Element {
  const [open, setOpen] = useState(false)
  const done = todos.filter((t) => t.status === 'completed').length
  const current = todos.find((t) => t.status === 'in_progress') ?? todos.find((t) => t.status === 'pending')
  return (
    <section className="pinned-todos" aria-label="Task list">
      <button
        type="button"
        className="pinned-todos__head"
        aria-expanded={open}
        aria-controls="pinned-todos-list"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="pinned-todos__count">
          {done} of {todos.length} done
        </span>
        {current && !open && (
          <span className="pinned-todos__current">
            <span aria-hidden="true">{MARK[current.status]} </span>
            {current.content}
          </span>
        )}
        <span className="pinned-todos__toggle">{open ? 'Hide' : 'Show all'}</span>
      </button>
      {open && (
        <ul className="pinned-todos__list" id="pinned-todos-list">
          {todos.map((t, i) => (
            <li key={i} className={`todo todo--${t.status}`}>
              <span className="todo__mark" aria-hidden="true">
                {MARK[t.status]}
              </span>
              <span className="todo__text">
                {t.content}
                <span className="sr-only">
                  {t.status === 'completed' ? ' (done)' : t.status === 'in_progress' ? ' (in progress)' : ''}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
