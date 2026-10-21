import { BackgroundTasks } from './BackgroundTasks'
import type { BackgroundTask } from '../hooks/useBackgroundTasks'
import { Icon } from './Icon'
import { Tooltip, TooltipProvider } from './Tooltip'

/**
 * A slim, draggable strip at the top of the main pane. With the window's
 * `hiddenInset` traffic lights it keeps the top of the window draggable (the
 * sidebar covers the left), and shows the current chat's title for context now
 * that the model/mode controls live in the bottom bar. Top-right actions show
 * the background-tasks count (opening the side panel's Tasks tab), open the Files browser and working-tree diff panel, toggle
 * the preview panel, and toggle the integrated terminal. Each action carries a
 * shared custom tooltip (see {@link TooltipProvider}) — instant on hover and
 * smooth as the pointer moves along the row, unlike the slow native `title`.
 */
export function Titlebar({
  title,
  tasks,
  tasksOpen,
  onToggleTasks,
  changes,
  onShowFiles,
  onShowChanges,
  onTogglePreview,
  previewOpen,
  previewCount,
  onToggleTerminal,
  terminalOpen,
  onToggleSideChat,
  sideChatOpen,
  terminalShortcut
}: {
  title: string
  /** Background work (terminals + backgrounded shells) for the indicator's count. */
  tasks?: BackgroundTask[]
  /** The side panel is open on its Tasks tab. */
  tasksOpen?: boolean
  /** Open or close the side panel's Tasks tab. */
  onToggleTasks?: () => void
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
  /** Toggle the side chat (a read-only aside about this chat). Absent with no open chat. */
  onToggleSideChat?: () => void
  sideChatOpen?: boolean
  /** The terminal toggle's shortcut as displayed on this platform (e.g. ⌃`, Ctrl+`). */
  terminalShortcut?: string
}): JSX.Element {
  const hasChanges = !!changes && changes.fileCount > 0
  return (
    <header className="titlebar">
      <span className="titlebar__title">{title}</span>
      <div className="titlebar__actions">
        <TooltipProvider>
          {tasks && onToggleTasks && (
            <BackgroundTasks tasks={tasks} active={!!tasksOpen} onToggle={onToggleTasks} />
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
                  ? `Changes: ${changes.fileCount} changed file${changes.fileCount === 1 ? '' : 's'} (+${changes.added} −${changes.removed}). View uncommitted changes`
                  : 'Changes: view uncommitted working-tree changes'
              }
            >
              <button
                type="button"
                className="titlebar__action"
                onClick={onShowChanges}
                aria-label="Changes"
                data-tour="changes"
              >
                <Icon name="diff" size={15} />
                {hasChanges && <span className="titlebar__badge">{changes.fileCount}</span>}
              </button>
            </Tooltip>
          )}
          {onToggleTerminal && (
            <Tooltip
              label={`Terminal: toggle the integrated terminal${terminalShortcut ? ` (${terminalShortcut})` : ''}`}
            >
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
          {onToggleSideChat && (
            <Tooltip label="Side chat: ask a quick question without interrupting this chat">
              <button
                type="button"
                className={`titlebar__action${sideChatOpen ? ' titlebar__action--active' : ''}`}
                onClick={onToggleSideChat}
                aria-label="Side chat"
                aria-pressed={sideChatOpen}
              >
                <Icon name="sideChat" size={15} />
              </button>
            </Tooltip>
          )}
        </TooltipProvider>
      </div>
    </header>
  )
}
