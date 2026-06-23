import { useState } from 'react'
import type { ToolApprovalDecision } from '@shared/agent'
import { parseTodosSafe, type Todo } from '@shared/todos'
import type { ToolItem } from '../lib/items'

const KIND_ICON: Record<string, string> = { read: '📖', write: '✏️', shell: '⌘', network: '🌐' }

const TODO_MARK: Record<Todo['status'], string> = {
  pending: '○',
  in_progress: '◐',
  completed: '●'
}

const STATUS_LABEL: Record<ToolItem['status'], string> = {
  'awaiting-approval': 'Needs approval',
  running: 'Running…',
  done: 'Done',
  error: 'Error',
  denied: 'Denied'
}

function detail(item: ToolItem): string {
  if (item.summary) return item.summary
  if (item.name === 'run_shell' && typeof item.args?.command === 'string') return item.args.command
  if (typeof item.args?.url === 'string') return item.args.url
  if (typeof item.args?.path === 'string') return item.args.path
  if (typeof item.args?.pattern === 'string') return `/${item.args.pattern}/`
  return ''
}

export function ToolCard({
  item,
  onApprove
}: {
  item: ToolItem
  onApprove: (callId: string, decision: ToolApprovalDecision) => void
}): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const todos = item.name === 'todo_write' ? parseTodosSafe(item.args?.todos) : []
  const isTodo = item.name === 'todo_write' && todos.length > 0
  const d = isTodo ? '' : detail(item)

  return (
    <div className={`tool-card tool-card--${item.status}`}>
      <div className="tool-card__head">
        <span className="tool-card__icon">{isTodo ? '📝' : KIND_ICON[item.toolKind ?? ''] ?? '🔧'}</span>
        <span className="tool-card__name">{isTodo ? 'todos' : item.name}</span>
        {d && <code className="tool-card__detail">{d}</code>}
        <span className={`tool-card__status tool-card__status--${item.status}`}>
          {STATUS_LABEL[item.status]}
        </span>
      </div>

      {isTodo && (
        <ul className="todo-list">
          {todos.map((t, i) => (
            <li key={i} className={`todo todo--${t.status}`}>
              <span className="todo__mark">{TODO_MARK[t.status]}</span>
              <span className="todo__text">{t.content}</span>
            </li>
          ))}
        </ul>
      )}

      {item.status === 'awaiting-approval' && (
        <div className="tool-card__approval">
          <button className="btn btn--ok" onClick={() => onApprove(item.id, 'allow')}>
            Allow
          </button>
          <button className="btn" onClick={() => onApprove(item.id, 'always')}>
            Allow for run
          </button>
          <button className="btn btn--danger" onClick={() => onApprove(item.id, 'deny')}>
            Deny
          </button>
        </div>
      )}

      {item.output && !isTodo && (
        <div className="tool-card__output">
          <button className="tool-card__toggle" onClick={() => setExpanded((v) => !v)}>
            {expanded ? '▾ Hide output' : '▸ Show output'}
          </button>
          {expanded && <pre>{item.output}</pre>}
        </div>
      )}
    </div>
  )
}
