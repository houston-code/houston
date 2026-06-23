import { useState } from 'react'
import type { ToolApprovalDecision } from '@shared/agent'
import { parseTodosSafe, type Todo } from '@shared/todos'
import { diffLines, diffStat, type DiffLine } from '@shared/diff'
import type { ToolItem } from '../lib/items'
import { describeTool } from '../lib/toolDisplay'

const MAX_DIFF_LINES = 300

const KIND_ICON: Record<string, string> = {
  read: '○',
  write: '◆',
  shell: '›_',
  network: '@'
}
const TOOL_ICON: Record<string, string> = {
  read_file: '○',
  list_dir: '○',
  glob: '○',
  search_files: '⌕',
  write_file: '◆',
  edit_file: '◆',
  run_shell: '›_',
  read_shell_output: '›_',
  kill_shell: '›_',
  web_fetch: '@',
  web_search: '⌕',
  todo_write: '☰'
}

const TODO_MARK: Record<Todo['status'], string> = { pending: '○', in_progress: '◐', completed: '●' }

function iconFor(item: ToolItem): string {
  return TOOL_ICON[item.name] ?? KIND_ICON[item.toolKind ?? ''] ?? '·'
}

/** Build a line diff for file-changing tools, from the tool arguments. */
function diffFor(item: ToolItem): DiffLine[] | null {
  const a = item.args
  if (!a) return null
  if (item.name === 'edit_file' && typeof a.old_string === 'string' && typeof a.new_string === 'string') {
    return diffLines(a.old_string, a.new_string)
  }
  if (item.name === 'write_file' && typeof a.content === 'string') {
    return diffLines('', a.content)
  }
  return null
}

const GLYPH: Record<Exclude<ToolItem['status'], 'running'>, string> = {
  'awaiting-approval': '●',
  done: '✓',
  error: '✕',
  denied: '⊘'
}

function StatusGlyph({ status }: { status: ToolItem['status'] }): JSX.Element {
  if (status === 'running') return <span className="tool-row__spinner" aria-label="running" />
  return <span className={`tool-row__glyph tool-row__glyph--${status}`}>{GLYPH[status]}</span>
}

function DiffView({ diff }: { diff: DiffLine[] }): JSX.Element {
  return (
    <pre className="diff">
      {diff.slice(0, MAX_DIFF_LINES).map((l, i) => (
        <div key={i} className={`diff__line diff__line--${l.type}`}>
          <span className="diff__sign">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}</span>
          <span className="diff__text">{l.text || ' '}</span>
        </div>
      ))}
      {diff.length > MAX_DIFF_LINES && (
        <div className="diff__more">… {diff.length - MAX_DIFF_LINES} more lines</div>
      )}
    </pre>
  )
}

function ToolRow({
  item,
  onApprove
}: {
  item: ToolItem
  onApprove: (callId: string, decision: ToolApprovalDecision) => void
}): JSX.Element {
  const todos = item.name === 'todo_write' ? parseTodosSafe(item.args?.todos) : []
  const isTodo = item.name === 'todo_write' && todos.length > 0
  const diff = diffFor(item)
  const stat = diff && diff.length > 0 ? diffStat(diff) : null
  const { verb, target, mono } = describeTool(item)
  const awaiting = item.status === 'awaiting-approval'

  // Open the diff/output by default while a change is awaiting approval.
  const [open, setOpen] = useState(awaiting)
  // Todo rows render their checklist inline, so they have nothing extra to expand.
  const expandable = !isTodo && Boolean((diff && diff.length > 0) || item.output)
  const toggle = (): void => {
    if (expandable) setOpen((v) => !v)
  }

  return (
    <div className={`tool-row tool-row--${item.status}`}>
      <div
        className={`tool-row__head${expandable ? ' tool-row__head--clickable' : ''}`}
        onClick={toggle}
      >
        <StatusGlyph status={item.status} />
        <span className="tool-row__icon">{iconFor(item)}</span>
        <span className="tool-row__verb">{verb}</span>
        {target && (
          <span className={`tool-row__target${mono ? ' tool-row__target--mono' : ''}`} title={target}>
            {target}
          </span>
        )}
        <span className="tool-row__spacer" />
        {stat && (
          <span className="diff-stat">
            <span className="diff-stat__add">+{stat.added}</span>
            <span className="diff-stat__del">−{stat.removed}</span>
          </span>
        )}
        {expandable && <span className="tool-row__chevron">{open ? '▾' : '▸'}</span>}
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

      {open && diff && diff.length > 0 && <DiffView diff={diff} />}
      {open && item.output && !isTodo && <pre className="tool-row__output">{item.output}</pre>}

      {awaiting && (
        <div className="tool-row__approval">
          <button className="btn btn--sm btn--ok" onClick={() => onApprove(item.id, 'allow')}>
            Allow
          </button>
          <button className="btn btn--sm" onClick={() => onApprove(item.id, 'always')}>
            Allow for run
          </button>
          <button className="btn btn--sm btn--danger" onClick={() => onApprove(item.id, 'deny')}>
            Deny
          </button>
        </div>
      )}
    </div>
  )
}

export function ToolGroup({
  items,
  onApprove
}: {
  items: ToolItem[]
  onApprove: (callId: string, decision: ToolApprovalDecision) => void
}): JSX.Element {
  const active = items.some((it) => it.status === 'awaiting-approval' || it.status === 'running')
  return (
    <div className={`tool-group${active ? ' tool-group--active' : ''}`}>
      {items.map((it) => (
        <ToolRow key={it.id} item={it} onApprove={onApprove} />
      ))}
    </div>
  )
}
