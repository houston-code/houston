import { useRef, useState } from 'react'
import { Popover } from './Popover'
import type { BackgroundTask } from '../hooks/useBackgroundTasks'

/** Coarse "x ago" label for a finished task; precision isn't important here. */
function formatAgo(now: number, then: number): string {
  const s = Math.max(0, Math.round((now - then) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

const STATUS_LABEL: Record<BackgroundTask['status'], string> = {
  running: 'Running',
  done: 'Completed',
  error: 'Failed'
}

const KIND_LABEL: Record<BackgroundTask['kind'], string> = {
  chat: 'Chat',
  terminal: 'Terminal',
  shell: 'Shell'
}

/** The dim secondary line: kind, location, status, and (when finished) age. */
function metaLine(task: BackgroundTask, now: number): string {
  return [
    KIND_LABEL[task.kind],
    task.subtitle,
    STATUS_LABEL[task.status],
    task.finishedAt !== undefined ? formatAgo(now, task.finishedAt) : ''
  ]
    .filter(Boolean)
    .join(' · ')
}

/**
 * Top-right indicator for background tasks — agent runs across conversations and
 * integrated terminal sessions, plus the most recently finished of each. The
 * button shows a live count while anything is in progress; clicking a task in the
 * popover opens that conversation or terminal.
 */
export function BackgroundTasks({
  tasks,
  onSelect,
  onClearFinished
}: {
  tasks: BackgroundTask[]
  onSelect: (task: BackgroundTask) => void
  onClearFinished: () => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)

  const runningCount = tasks.filter((t) => t.status === 'running').length
  const hasFinished = tasks.some((t) => t.status !== 'running')
  const now = Date.now()

  const pick = (task: BackgroundTask): void => {
    onSelect(task)
    setOpen(false)
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`titlebar__action bgtasks__btn${runningCount > 0 ? ' titlebar__action--active' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={
          runningCount > 0 ? `Background tasks, ${runningCount} running` : 'Background tasks'
        }
        title={
          runningCount > 0
            ? `${runningCount} background task${runningCount === 1 ? '' : 's'} running`
            : 'Background tasks'
        }
        onClick={() => setOpen((v) => !v)}
      >
        <span
          className="bgtasks__dot"
          data-running={runningCount > 0 ? '' : undefined}
          aria-hidden="true"
        />
        Tasks
        {runningCount > 0 && <span className="bgtasks__count">{runningCount}</span>}
      </button>

      {open && (
        <Popover
          anchorRef={btnRef}
          onClose={() => setOpen(false)}
          align="right"
          role="menu"
          ariaLabel="Background tasks"
          className="menu bgtasks__menu"
        >
          <div className="bgtasks__head">
            <span className="bgtasks__title">Background tasks</span>
            {hasFinished && (
              <button type="button" className="bgtasks__clear" onClick={() => onClearFinished()}>
                Clear finished
              </button>
            )}
          </div>

          {tasks.length === 0 ? (
            <div className="bgtasks__empty">
              No background tasks. Agent runs and terminals you start keep going here
              while you work elsewhere.
            </div>
          ) : (
            <ul className="bgtasks__list">
              {tasks.map((t) => (
                <li key={`${t.kind}:${t.id}`}>
                  <button
                    type="button"
                    role="menuitem"
                    className="bgtasks__item"
                    onClick={() => pick(t)}
                  >
                    <span
                      className={`bgtasks__status bgtasks__status--${t.status}`}
                      aria-hidden="true"
                    >
                      {t.status === 'running' ? '' : t.status === 'error' ? '✕' : '✓'}
                    </span>
                    <span className="bgtasks__body">
                      <span className="bgtasks__name">{t.title}</span>
                      <span className="bgtasks__meta">{metaLine(t, now)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Popover>
      )}
    </>
  )
}
