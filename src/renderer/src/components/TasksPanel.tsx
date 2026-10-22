import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { KillShellOutcome } from '@shared/agent'
import type { BackgroundTask } from '../hooks/useBackgroundTasks'
import { copyText } from '../lib/clipboard'
import { Icon } from './Icon'

/** Coarse "x ago" label; precision isn't important here. */
export function formatAgo(now: number, then: number): string {
  const s = Math.max(0, Math.round((now - then) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}


/** The dim line under a row's title: what state it's in, where, and since when. */
function metaLine(t: BackgroundTask, now: number): string {
  const kind = t.kind === 'terminal' ? 'Terminal' : 'Shell'
  let state: string
  switch (t.status) {
    case 'running':
      if (t.startedAt === undefined) state = 'Running'
      else {
        const ago = formatAgo(now, t.startedAt)
        state = ago === 'just now' ? 'Started just now' : `Running for ${ago.replace(' ago', '')}`
      }
      break
    case 'leftover':
      state = 'Exited, server still running'
      break
    case 'done':
      state = t.finishedAt !== undefined ? `Completed ${formatAgo(now, t.finishedAt)}` : 'Completed'
      break
    case 'error':
      state =
        (typeof t.exitCode === 'number' ? `Failed (exit ${t.exitCode})` : 'Stopped') +
        (t.finishedAt !== undefined ? ` ${formatAgo(now, t.finishedAt)}` : '')
      break
  }
  return [kind, state, t.subtitle].filter(Boolean).join(' · ')
}

/** How often an expanded live row refreshes its output tail. */
const TAIL_POLL_MS = 2000

/** What a Stop click did, phrased for the row's status line. */
const STOP_RESULT: Record<KillShellOutcome, string> = {
  killed: 'Stopped.',
  'killed-leftovers': 'Stopped the process it left running.',
  'already-exited': 'Nothing was still running.',
  'not-found': 'This task is no longer tracked.'
}

/** Shown when the Stop request itself failed (IPC error), so the click isn't silent. */
const STOP_FAILED = "Couldn't stop this task. Try again."

function StatusIcon({ status }: { status: BackgroundTask['status'] }): JSX.Element {
  if (status === 'running') return <span className="tasks__status tasks__status--running" aria-hidden="true" />
  if (status === 'leftover')
    return (
      <span className="tasks__status tasks__status--leftover" aria-hidden="true">
        <Icon name="warning" size={13} />
      </span>
    )
  return (
    <span className={`tasks__status tasks__status--${status}`} aria-hidden="true">
      <Icon name={status === 'error' ? 'close' : 'check'} size={12} />
    </span>
  )
}

function TaskRow({
  task,
  now,
  expanded,
  active,
  onToggle,
  onStop,
  onOpenPreview,
  onGoToChat,
  onOpenTerminal,
  note,
  onNote,
  currentId
}: {
  task: BackgroundTask
  /** The open chat: a task it started needs no "Go to chat". */
  currentId: string | null
  now: number
  expanded: boolean
  /** The Tasks tab is showing; a hidden row doesn't poll. */
  active: boolean
  onToggle: () => void
  /** The outcome of this row's last Stop. Kept by the panel: a stopped row moves groups and remounts. */
  note: string
  onNote: (note: string) => void
  onStop: (id: string) => Promise<KillShellOutcome>
  onOpenPreview: (task: BackgroundTask) => void
  onGoToChat: (task: BackgroundTask) => void
  onOpenTerminal: (task: BackgroundTask) => void
}): JSX.Element {
  const bodyId = useId()
  // undefined: not loaded yet. null: main no longer tracks this shell.
  const [tail, setTail] = useState<string[] | null | undefined>(undefined)
  const [copied, setCopied] = useState(false)
  const [stopping, setStopping] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const outputRef = useRef<HTMLDivElement>(null)
  // Follow the newest output like a terminal, unless the user scrolled up to read.
  const pinnedToBottom = useRef(true)
  const live = task.status === 'running' || task.status === 'leftover'
  const isShell = task.kind === 'shell'

  // Fetch the output tail while expanded and visible; keep it fresh while the task is
  // live. A row on a hidden tab (dock showing Preview) doesn't poll.
  useEffect(() => {
    if (!expanded || !active || !isShell || typeof window.api?.getBackgroundShellTail !== 'function') return
    let alive = true
    const load = (): void => {
      void window.api.getBackgroundShellTail(task.id).then((lines) => {
        if (alive) setTail(lines)
      })
    }
    load()
    const timer = live ? setInterval(load, TAIL_POLL_MS) : null
    return () => {
      alive = false
      if (timer) clearInterval(timer)
    }
  }, [expanded, active, isShell, live, task.id])

  useLayoutEffect(() => {
    const el = outputRef.current
    if (el && pinnedToBottom.current) el.scrollTop = el.scrollHeight
  }, [tail, expanded])

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
    },
    []
  )

  const stop = async (): Promise<void> => {
    setStopping(true)
    try {
      onNote(STOP_RESULT[await onStop(task.id)])
    } catch {
      onNote(STOP_FAILED)
    } finally {
      setStopping(false)
    }
  }

  const copy = (): void => {
    if (!task.command) return
    void copyText(task.command).then((ok) => {
      if (!ok) return
      setCopied(true)
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(false), 1500)
    })
  }

  // Only a running shell's server is in the Preview tab (it shows running servers);
  // a leftover's page isn't, so it gets Stop but no Open preview.
  const canPreview = task.status === 'running' && !!task.urls?.length

  return (
    <li className={`tasks__row${expanded ? ' tasks__row--open' : ''}`}>
      <button
        type="button"
        className="tasks__head"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={onToggle}
        title={task.command ?? task.title}
      >
        <StatusIcon status={task.status} />
        <span className="tasks__main">
          <span className="tasks__titleline">
            <span className="tasks__name">{task.title}</span>
            {/* A port chip means "this is holding the port": only while it's live. */}
            {live &&
              task.ports?.map((p) => (
                <span key={p} className="tasks__chip">
                  {p}
                </span>
              ))}
          </span>
          <span className="tasks__meta">{metaLine(task, now)}</span>
        </span>
        <Icon name="chevronRight" size={13} className="tasks__chevron" />
      </button>

      <div id={bodyId} className="tasks__body" hidden={!expanded}>
        {task.status === 'leftover' && (
          <p className="tasks__warn">
            <Icon name="warning" size={13} />
            <span>
              The shell exited, but a process it started is still running
              {task.ports?.length ? ` and holding ${task.ports.join(', ')}` : ''}.
            </span>
          </p>
        )}

        {task.command && (
          <div className="tasks__cmd">
            <pre className="tasks__cmdtext">{task.command}</pre>
            <button
              type="button"
              className="tasks__iconbtn"
              aria-label={copied ? 'Command copied' : 'Copy command'}
              title={copied ? 'Copied' : 'Copy command'}
              onClick={copy}
            >
              <Icon name={copied ? 'check' : 'copy'} size={13} />
            </button>
          </div>
        )}

        <dl className="tasks__facts">
          {task.subtitle && (
            <>
              <dt>Folder</dt>
              <dd>{task.subtitle}</dd>
            </>
          )}
          {task.startedAt !== undefined && (
            <>
              <dt>Started</dt>
              <dd>
                {new Date(task.startedAt).toLocaleString(undefined, {
                  weekday: 'short',
                  hour: '2-digit',
                  minute: '2-digit'
                })}
              </dd>
            </>
          )}
          {live && task.urls?.length ? (
            <>
              <dt>Listening</dt>
              <dd>
                {task.urls.join(', ')}
                {task.exposed && <span className="tasks__exposed"> (reachable from your network)</span>}
              </dd>
            </>
          ) : null}
          {typeof task.exitCode === 'number' && !live && (
            <>
              <dt>Exit code</dt>
              <dd>{task.exitCode}</dd>
            </>
          )}
        </dl>

        {isShell && (
          <div
            className="tasks__output"
            aria-label="Recent output"
            ref={outputRef}
            tabIndex={0}
            onScroll={(e) => {
              const el = e.currentTarget
              pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8
            }}
          >
            {tail === undefined ? (
              <span className="tasks__dim">Loading output…</span>
            ) : tail === null ? (
              <span className="tasks__dim">Output is no longer available.</span>
            ) : tail.length === 0 ? (
              <span className="tasks__dim">No output yet.</span>
            ) : (
              <pre>{tail.join('\n')}</pre>
            )}
          </div>
        )}

        <div className="tasks__actions">
          {isShell && live && (
            <button type="button" className="btn btn--sm" disabled={stopping} onClick={() => void stop()}>
              {task.status === 'leftover' ? 'Stop leftover process' : 'Stop'}
            </button>
          )}
          {canPreview && (
            <button type="button" className="btn btn--sm" onClick={() => onOpenPreview(task)}>
              Open preview
            </button>
          )}
          {task.kind === 'terminal' && (
            <button type="button" className="btn btn--sm" onClick={() => onOpenTerminal(task)}>
              Open terminal
            </button>
          )}
          {task.conversationId && task.conversationId !== currentId && (
            <button type="button" className="btn btn--sm" onClick={() => onGoToChat(task)}>
              Go to chat
            </button>
          )}
        </div>
        <p className="tasks__note" role="status" aria-live="polite">
          {note}
        </p>
      </div>
    </li>
  )
}

/**
 * The Tasks tab of the right-hand dock: integrated terminals and the agent's
 * backgrounded shells, running work first. Each row names the command that does the
 * work (setup steps stripped, see describeShell), its port and folder, and expands
 * to the full command, recent output, and Stop / Open preview / Go to chat.
 */
export function TasksPanel({
  tasks,
  active = true,
  onStop,
  onOpenPreview,
  onGoToChat,
  onOpenTerminal,
  onClearFinished,
  currentId = null,
  now = Date.now
}: {
  tasks: BackgroundTask[]
  /** The open chat, whose own tasks don't offer "Go to chat". */
  currentId?: string | null
  /** The Tasks tab is visible. Expanded rows stop refreshing their output when it isn't. */
  active?: boolean
  onStop: (id: string) => Promise<KillShellOutcome>
  onOpenPreview: (task: BackgroundTask) => void
  onGoToChat: (task: BackgroundTask) => void
  onOpenTerminal: (task: BackgroundTask) => void
  onClearFinished: () => void
  now?: () => number
}): JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [notes, setNotes] = useState<Record<string, string>>({})
  const toggle = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const t = now()
  const live = tasks.filter((x) => x.status === 'running' || x.status === 'leftover')
  const finished = tasks.filter((x) => x.status === 'done' || x.status === 'error')

  const row = (task: BackgroundTask): JSX.Element => {
    const key = `${task.kind}:${task.id}`
    return (
      <TaskRow
        key={key}
        task={task}
        now={t}
        expanded={expanded.has(key)}
        active={active}
        onToggle={() => toggle(key)}
        onStop={onStop}
        onOpenPreview={onOpenPreview}
        onGoToChat={onGoToChat}
        onOpenTerminal={onOpenTerminal}
        currentId={currentId}
        note={notes[key] ?? ''}
        onNote={(n) => setNotes((prev) => ({ ...prev, [key]: n }))}
      />
    )
  }

  if (tasks.length === 0) {
    return (
      <div className="tasks tasks--empty">
        <p>No background tasks.</p>
        <p className="tasks__dim">
          Terminals and commands the agent runs in the background show up here while you work
          elsewhere.
        </p>
      </div>
    )
  }

  return (
    <div className="tasks">
      {live.length > 0 && (
        <section aria-label="Running">
          <h3 className="tasks__section">Running · {live.length}</h3>
          <ul className="tasks__list">{live.map(row)}</ul>
        </section>
      )}
      {finished.length > 0 && (
        <section aria-label="Finished">
          <h3 className="tasks__section">
            <span>Finished</span>
            <button type="button" className="tasks__clear" onClick={onClearFinished}>
              Clear finished
            </button>
          </h3>
          <ul className="tasks__list">{finished.map(row)}</ul>
        </section>
      )}
    </div>
  )
}
