import { useState } from 'react'
import type { ToolApprovalDecision } from '@shared/agent'
import type { ToolItem } from '../lib/items'

const KIND_ICON: Record<string, string> = { read: '📖', write: '✏️', shell: '⌘' }

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
  const d = detail(item)

  return (
    <div className={`tool-card tool-card--${item.status}`}>
      <div className="tool-card__head">
        <span className="tool-card__icon">{KIND_ICON[item.toolKind ?? ''] ?? '🔧'}</span>
        <span className="tool-card__name">{item.name}</span>
        {d && <code className="tool-card__detail">{d}</code>}
        <span className={`tool-card__status tool-card__status--${item.status}`}>
          {STATUS_LABEL[item.status]}
        </span>
      </div>

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

      {item.output && (
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
