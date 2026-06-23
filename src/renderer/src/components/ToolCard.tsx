import { useState } from 'react'
import type { ToolApprovalDecision } from '@shared/agent'
import { parseTodosSafe, type Todo } from '@shared/todos'
import { diffLines, diffStat, type DiffLine } from '@shared/diff'
import type { ToolItem } from '../lib/items'

const KIND_ICON: Record<string, string> = { read: '📖', write: '✏️', shell: '⌘', network: '🌐' }

const MAX_DIFF_LINES = 300

/** Build a line diff for file-changing tools, from the tool arguments. */
function diffFor(item: ToolItem): DiffLine[] | null {
  const a = item.args
  if (!a) return null
  if (item.name === 'edit_file' && typeof a.old_string === 'string' && typeof a.new_string === 'string') {
    return diffLines(a.old_string, a.new_string)
  }
  // write_file has no prior content available client-side, so an overwrite shows
  // as all-additions (which reads correctly for new files).
  if (item.name === 'write_file' && typeof a.content === 'string') {
    return diffLines('', a.content)
  }
  return null
}

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
  const diff = diffFor(item)
  const stat = diff ? diffStat(diff) : null
  // Open by default while awaiting approval so the change can be reviewed first.
  const [diffOpen, setDiffOpen] = useState(item.status === 'awaiting-approval')
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

      {diff && diff.length > 0 && (
        <div className="tool-card__diff">
          <button className="tool-card__toggle" onClick={() => setDiffOpen((v) => !v)}>
            {diffOpen ? '▾ Hide diff' : '▸ Show diff'}{' '}
            <span className="diff-stat">
              <span className="diff-stat__add">+{stat!.added}</span>{' '}
              <span className="diff-stat__del">−{stat!.removed}</span>
            </span>
          </button>
          {diffOpen && (
            <pre className="diff">
              {diff.slice(0, MAX_DIFF_LINES).map((l, i) => (
                <div key={i} className={`diff__line diff__line--${l.type}`}>
                  <span className="diff__sign">
                    {l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}
                  </span>
                  <span className="diff__text">{l.text || ' '}</span>
                </div>
              ))}
              {diff.length > MAX_DIFF_LINES && (
                <div className="diff__more">… {diff.length - MAX_DIFF_LINES} more lines</div>
              )}
            </pre>
          )}
        </div>
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
