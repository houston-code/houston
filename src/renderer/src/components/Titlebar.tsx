import { BackgroundTasks } from './BackgroundTasks'
import type { BackgroundTask } from '../hooks/useBackgroundTasks'
import { Icon } from './Icon'
import { Tooltip, TooltipProvider } from './Tooltip'

/**
 * A slim, draggable strip at the top of the main pane. With the window's
 * `hiddenInset` traffic lights it keeps the top of the window draggable (the
 * sidebar covers the left), and shows the current chat's title for context now
 * that the model/mode controls live in the bottom bar. Top-right actions show
 * background tasks, open the Files browser and working-tree diff panel, toggle
 * the preview panel, and toggle the integrated terminal. Each action carries a
 * shared custom tooltip (see {@link TooltipProvider}) — instant on hover and
 * smooth as the pointer moves along the row, unlike the slow native `title`.
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
        <TooltipProvider>
          {tasks && onSelectTask && (
            <BackgroundTasks
              tasks={tasks}
              onSelect={onSelectTask}
              onClearFinished={onClearFinishedTasks ?? (() => {})}
            />
          )}
          {onTogglePreview && (
            <Tooltip label="Preview: toggle the live preview panel">
              <button
                type="button"
                className={`titlebar__action${previewOpen ? ' titlebar__action--active' : ''}`}
                onClick={onTogglePreview}
                aria-label="Preview"
                aria-pressed={previewOpen}
              >
                <Icon name="eye" size={15} />
                {!!previewCount && previewCount > 0 && (
                  <span className="titlebar__badge">{previewCount}</span>
                )}
              </button>
            </Tooltip>
          )}
          {onShowFiles && (
            <Tooltip label="Files: browse the project's files">
              <button
                type="button"
                className="titlebar__action"
                onClick={onShowFiles}
                aria-label="Files"
              >
                <Icon name="folder" size={15} />
              </button>
            </Tooltip>
          )}
          {onShowChanges && (
            <Tooltip
              label={
                hasChanges
                  ? `Changes: ${changes.fileCount} changed file${changes.fileCount === 1 ? '' : 's'} (+${changes.added} −${changes.removed}) — view uncommitted changes`
                  : 'Changes: view uncommitted working-tree changes'
              }
            >
              <button
                type="button"
                className="titlebar__action"
                onClick={onShowChanges}
                aria-label="Changes"
              >
                <Icon name="diff" size={15} />
                {hasChanges && <span className="titlebar__badge">{changes.fileCount}</span>}
              </button>
            </Tooltip>
          )}
          {onToggleTerminal && (
            <Tooltip label="Terminal: toggle the integrated terminal (⌃`)">
              <button
                type="button"
                className={`titlebar__action${terminalOpen ? ' titlebar__action--active' : ''}`}
                onClick={onToggleTerminal}
                aria-label="Terminal"
                aria-pressed={terminalOpen}
              >
                <Icon name="terminal" size={15} />
              </button>
            </Tooltip>
          )}
        </TooltipProvider>
      </div>
    </header>
  )
}
