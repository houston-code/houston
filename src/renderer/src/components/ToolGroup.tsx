import { useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { MAX_APPROVAL_NOTE, type ToolApprovalDecision } from '@shared/agent'
import { imageDataUrl } from '@shared/images'
import { parseTodosSafe, type Todo } from '@shared/todos'
import { parseSweepItemsSafe, type SweepItem, type SweepItemStatus } from '@shared/sweep'
import { diffLines, diffStat, type DiffLine } from '@shared/diff'
import type { ToolItem } from '../lib/items'
import { describeTool, foldReadRuns } from '../lib/toolDisplay'
import { DiffView } from './DiffView'

const KIND_ICON: Record<string, string> = {
  read: '○',
  write: '◆',
  shell: '›_',
  network: '@',
  mcp: '⚇'
}
const TOOL_ICON: Record<string, string> = {
  read_file: '○',
  list_dir: '○',
  glob: '○',
  search_files: '⌕',
  write_file: '◆',
  edit_file: '◆',
  notebook_edit: '◈',
  run_shell: '›_',
  read_shell_output: '›_',
  kill_shell: '›_',
  web_fetch: '@',
  view_localhost: '▣',
  web_search: '⌕',
  todo_write: '☰',
  spawn_session: '⧉',
  pr_sweep: '⇄',
  gh_pr_create: '⌥',
  gh_pr_list: '@',
  gh_pr_view: '@',
  gh_pr_comment: '@',
  gh_pr_checkout: '@'
}

const TODO_MARK: Record<Todo['status'], string> = { pending: '○', in_progress: '◐', completed: '●' }

const SWEEP_MARK: Record<SweepItemStatus, string> = {
  pending: '○',
  in_progress: '◐',
  pushed: '↑',
  pr_open: '◑',
  done: '●',
  failed: '✕'
}

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

function ToolRow({
  item,
  onApprove
}: {
  item: ToolItem
  onApprove: (callId: string, decision: ToolApprovalDecision, note?: string) => void
}): JSX.Element {
  const todos = item.name === 'todo_write' ? parseTodosSafe(item.args?.todos) : []
  const isTodo = item.name === 'todo_write' && todos.length > 0
  const sweep = item.name === 'pr_sweep' ? parseSweepItemsSafe(item.args?.items) : []
  const isSweep = item.name === 'pr_sweep' && sweep.length > 0
  const diff = diffFor(item)
  const stat = diff && diff.length > 0 ? diffStat(diff) : null
  const { verb, target, mono } = describeTool(item)
  const awaiting = item.status === 'awaiting-approval'

  // Open the diff/output by default while a change is awaiting approval.
  const [open, setOpen] = useState(awaiting)
  // Guidance to send with a denial ("no, use staging instead").
  const [note, setNote] = useState('')
  // Todo/sweep rows render their list inline, so they have nothing extra to expand.
  const expandable = !isTodo && !isSweep && Boolean((diff && diff.length > 0) || item.output)
  const toggle = (): void => {
    if (expandable) setOpen((v) => !v)
  }

  return (
    <div className={`tool-row tool-row--${item.status}`}>
      <div
        className={`tool-row__head${expandable ? ' tool-row__head--clickable' : ''}`}
        onClick={toggle}
        {...(expandable
          ? {
              role: 'button',
              tabIndex: 0,
              'aria-expanded': open,
              onKeyDown: (e: ReactKeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  toggle()
                }
              }
            }
          : {})}
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

      {item.status === 'running' && item.progress && (
        <div className="tool-row__progress">{item.progress}</div>
      )}

      {item.subagents && item.subagents.length > 0 && (
        <ul className="tool-row__subagents">
          {item.subagents.map((s) => (
            <li key={s.id} className={`tool-row__subagent tool-row__subagent--${s.status}`}>
              <StatusGlyph status={s.status} />
              <span className="tool-row__subagent-label" title={s.label}>
                {s.label}
              </span>
            </li>
          ))}
        </ul>
      )}

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

      {isSweep && (
        <ul className="todo-list sweep-list">
          {sweep.map((s: SweepItem, i: number) => (
            <li key={i} className={`todo sweep sweep--${s.status}`}>
              <span className="todo__mark">{SWEEP_MARK[s.status]}</span>
              <span className="todo__text">{s.task}</span>
              {s.branch && <span className="sweep__chip sweep__chip--branch">{s.branch}</span>}
              {s.pr && <span className="sweep__chip sweep__chip--pr">{s.pr}</span>}
              {s.note && <span className="sweep__note">{s.note}</span>}
            </li>
          ))}
        </ul>
      )}

      {open && diff && diff.length > 0 && <DiffView diff={diff} />}
      {open && item.output && !isTodo && !isSweep && <pre className="tool-row__output">{item.output}</pre>}

      {item.images && item.images.length > 0 && (
        <div className="tool-row__images">
          {item.images.map((img, i) => (
            <img key={i} className="tool-row__image" src={imageDataUrl(img)} alt="screenshot" />
          ))}
        </div>
      )}

      {awaiting && item.shellNetwork && (
        <div className="tool-row__approval">
          <p className="tool-row__approval-note">
            Shell commands this run will be able to reach the network. They already run in
            a sandbox that can read your files, so this bounds where that data could go.
            Declining runs commands offline.
          </p>
          <button className="btn btn--sm btn--ok" onClick={() => onApprove(item.id, 'always')}>
            Allow network for run
          </button>
          <button className="btn btn--sm btn--danger" onClick={() => onApprove(item.id, 'deny')}>
            No network
          </button>
        </div>
      )}

      {awaiting && !item.shellNetwork && (
        <div className="tool-row__approval">
          <button className="btn btn--sm btn--ok" onClick={() => onApprove(item.id, 'allow')}>
            Allow
          </button>
          <button className="btn btn--sm" onClick={() => onApprove(item.id, 'always')}>
            Allow for run
          </button>
          <button
            className="btn btn--sm"
            title="Save a permission rule so this is allowed in future runs too"
            onClick={() => onApprove(item.id, 'rule-allow')}
          >
            Always allow
          </button>
          <button
            className="btn btn--sm btn--danger"
            onClick={() => onApprove(item.id, 'deny', note.trim() || undefined)}
          >
            Deny
          </button>
          <button
            className="btn btn--sm btn--danger"
            title="Save a permission rule so this is denied in future runs too"
            onClick={() => onApprove(item.id, 'rule-deny', note.trim() || undefined)}
          >
            Always deny
          </button>
          {/*
            Guidance rides the same interaction as the refusal. Without it a denial
            is a dead end: the agent is told only that it was refused, so it retries
            a variant instead of doing what you actually wanted.
          */}
          <input
            className="tool-row__approval-reason"
            type="text"
            value={note}
            placeholder="Why not? (optional — tell the agent what to do instead)"
            aria-label="Reason for denying, sent to the agent"
            maxLength={MAX_APPROVAL_NOTE}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              // Enter in the reason box means "deny, with this reason" — the only
              // verdict the text applies to, and the one they are already typing for.
              if (e.key === 'Enter' && note.trim()) onApprove(item.id, 'deny', note.trim())
            }}
          />
        </div>
      )}
    </div>
  )
}

/** The status a fold of reads shows: the most attention-worthy across the run. */
function combinedStatus(items: ToolItem[]): ToolItem['status'] {
  if (items.some((it) => it.status === 'running')) return 'running'
  if (items.some((it) => it.status === 'awaiting-approval')) return 'awaiting-approval'
  if (items.some((it) => it.status === 'error')) return 'error'
  if (items.some((it) => it.status === 'denied')) return 'denied'
  return 'done'
}

/** A fold of consecutive reads: one "Read N files" row that expands to the list. */
function ReadAggregateRow({ items }: { items: ToolItem[] }): JSX.Element {
  const [open, setOpen] = useState(false)
  const status = combinedStatus(items)
  return (
    <div className={`tool-row tool-row--${status}`}>
      <div
        className="tool-row__head tool-row__head--clickable"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setOpen((v) => !v)
          }
        }}
      >
        <StatusGlyph status={status} />
        <span className="tool-row__icon">○</span>
        <span className="tool-row__verb">Read</span>
        <span className="tool-row__target">{items.length} files</span>
        <span className="tool-row__spacer" />
        <span className="tool-row__chevron">{open ? '▾' : '▸'}</span>
      </div>
      {open && (
        <ul className="tool-reads">
          {items.map((it) => {
            const { target } = describeTool(it)
            return (
              <li key={it.id} className="tool-reads__item">
                <StatusGlyph status={it.status} />
                <span className="tool-reads__path" title={target}>
                  {target}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export function ToolGroup({
  items,
  onApprove
}: {
  items: ToolItem[]
  onApprove: (callId: string, decision: ToolApprovalDecision, note?: string) => void
}): JSX.Element {
  const active = items.some((it) => it.status === 'awaiting-approval' || it.status === 'running')
  const runs = foldReadRuns(items)
  return (
    <div className={`tool-group${active ? ' tool-group--active' : ''}`}>
      {runs.map((run) =>
        run.kind === 'reads' ? (
          <ReadAggregateRow key={run.id} items={run.items} />
        ) : (
          <ToolRow key={run.id} item={run.item} onApprove={onApprove} />
        )
      )}
    </div>
  )
}
