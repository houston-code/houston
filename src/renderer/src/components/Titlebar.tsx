import { BackgroundTasks } from './BackgroundTasks'
import type { BackgroundTask } from '../hooks/useBackgroundTasks'
import { Icon } from './Icon'

/**
 * A slim, draggable strip at the top of the main pane. With the window's
 * `hiddenInset` traffic lights it keeps the top of the window draggable (the
 * sidebar covers the left), and shows the current chat's title for context now
 * that the model/mode controls live in the bottom bar. Top-right actions show
 * background tasks, open the Files browser and working-tree diff panel, toggle
 * the preview panel, and toggle the integrated terminal.
 */
export function Titlebar({
  title,
  tasks,
  onSelectTask,
  onClearFinishedTasks,
  changes,
  onShowFiles,
  onShowChanges,
  onTogglePreview,
  previewOpen,
  previewCount,
  onToggleTerminal,
  terminalOpen
}: {
  title: string
  /** Background work (agent runs + terminals, in progress + recently finished) for the indicator. */
  tasks?: BackgroundTask[]
  onSelectTask?: (task: BackgroundTask) => void
  onClearFinishedTasks?: () => void
  /** Working-tree change counts; highlights the Changes button and shows a +/− badge. */
  changes?: { fileCount: number; added: number; removed: number }
  onShowFiles?: () => void
  onShowChanges?: () => void
  onTogglePreview?: () => void
  previewOpen?: boolean
  /** Number of running dev servers with a detected URL — shown as a badge when > 0. */
  previewCount?: number
  onToggleTerminal?: () => void
  terminalOpen?: boolean
}): JSX.Element {
  const hasChanges = !!changes && changes.fileCount > 0
  return (
    <header className="titlebar">
      <span className="titlebar__title">{title}</span>
      <div className="titlebar__actions">
        {tasks && onSelectTask && (
          <BackgroundTasks
            tasks={tasks}
            onSelect={onSelectTask}
            onClearFinished={onClearFinishedTasks ?? (() => {})}
          />
        )}
        {onTogglePreview && (
          <button
            type="button"
            className={`titlebar__action${previewOpen ? ' titlebar__action--active' : ''}`}
            onClick={onTogglePreview}
            title="Toggle the preview panel"
            aria-pressed={previewOpen}
          >
            <span aria-hidden="true">▣</span> Preview
            {!!previewCount && previewCount > 0 && (
              <span className="titlebar__badge">{previewCount}</span>
            )}
          </button>
        )}
        {onShowFiles && (
          <button
            type="button"
            className="titlebar__action"
            onClick={onShowFiles}
            title="Browse the project's files"
          >
            <Icon name="folder" /> Files
          </button>
        )}
        {onShowChanges && (
          <button
            type="button"
            className={`titlebar__action${hasChanges ? ' titlebar__action--changes' : ''}`}
            onClick={onShowChanges}
            title={
              hasChanges
                ? `${changes.fileCount} changed file${changes.fileCount === 1 ? '' : 's'} — view uncommitted changes`
                : 'View uncommitted working-tree changes'
            }
          >
            ⤓ Changes
            {hasChanges && (changes.added > 0 || changes.removed > 0) && (
              <span className="diff-stat">
                <span className="diff-stat__add">+{changes.added}</span>
                <span className="diff-stat__del">−{changes.removed}</span>
              </span>
            )}
          </button>
        )}
        {onToggleTerminal && (
          <button
            type="button"
            className={`titlebar__action${terminalOpen ? ' titlebar__action--active' : ''}`}
            onClick={onToggleTerminal}
            title="Toggle the integrated terminal (⌃`)"
            aria-pressed={terminalOpen}
          >
            <span aria-hidden="true">{'>_'}</span> Terminal
          </button>
        )}
      </div>
    </header>
  )
}
