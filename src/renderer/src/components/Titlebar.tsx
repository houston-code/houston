import { useLayoutEffect, useRef, useState } from 'react'
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
  filesOpen,
  onShowChanges,
  changesOpen,
  onTogglePreview,
  previewOpen,
  previewCount,
  onToggleTerminal,
  terminalOpen,
  onToggleSideChat,
  sideChatOpen,
  terminalShortcut,
  needsYou,
  onOpenPalette,
  paletteShortcut,
  onShowShortcuts,
  shortcutsShortcut
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
  /** Open or close the side panel's Files tab. */
  onShowFiles?: () => void
  /** The side panel is open on its Files tab. */
  filesOpen?: boolean
  /** Open or close the side panel's Changes tab. */
  onShowChanges?: () => void
  /** The side panel is open on its Changes tab. */
  changesOpen?: boolean
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
  /**
   * Other chats waiting on the user (approval, question, plan, input request): shows
   * a "N need you" pill that opens the next one. Absent or 0 hides it.
   */
  needsYou?: { count: number; onNext: () => void }
  /** Open the command palette. Shown as a labeled button, so it can be found without a shortcut. */
  onOpenPalette?: () => void
  /** The palette's shortcut as displayed on this platform (e.g. ⌘K). */
  paletteShortcut?: string
  /** Open the keyboard-shortcut sheet. */
  onShowShortcuts?: () => void
  /** The sheet's shortcut as displayed on this platform (e.g. ⌘/). */
  shortcutsShortcut?: string
}): JSX.Element {
  const hasChanges = !!changes && changes.fileCount > 0
  // Whether the title is cut short. Only then does it leave the window's drag region,
  // so hovering it can show the whole title (a drag region gets no pointer events);
  // a title that fits stays a handle for moving the window.
  const titleRef = useRef<HTMLSpanElement>(null)
  const [cut, setCut] = useState(false)
  useLayoutEffect(() => {
    const el = titleRef.current
    if (!el) return
    const check = (): void => setCut(el.scrollWidth > el.clientWidth)
    check()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [title])
  return (
    <header className="titlebar">
      {/* Title and actions are siblings: the title centers while there is room, then
          gives way to the actions and is cut short (hover shows it whole). */}
      <span className="titlebar__lead" aria-hidden="true" />
      <span ref={titleRef} className={`titlebar__title${cut ? ' titlebar__title--cut' : ''}`} title={title}>
        {title}
      </span>
      <div className="titlebar__actions">
        <TooltipProvider>
          {needsYou && needsYou.count > 0 && (
            <Tooltip label="Open the next chat waiting on you">
              <button type="button" className="titlebar__needs-you" onClick={needsYou.onNext}>
                <span className="titlebar__needs-you-dot" aria-hidden="true" />
                {needsYou.count === 1 ? '1 needs you' : `${needsYou.count} need you`}
              </button>
            </Tooltip>
          )}
          {onOpenPalette && (
            <Tooltip
              label={`Commands: actions, slash commands, models and chats${paletteShortcut ? ` (${paletteShortcut})` : ''}`}
            >
              <button
                type="button"
                className="titlebar__commands"
                onClick={onOpenPalette}
                aria-keyshortcuts={paletteShortcut ? ariaKeys(paletteShortcut) : undefined}
              >
                Commands
                {paletteShortcut && (
                  <kbd className="titlebar__kbd" aria-hidden="true">
                    {paletteShortcut}
                  </kbd>
                )}
              </button>
            </Tooltip>
          )}
          {onShowShortcuts && (
            <Tooltip label={`Keyboard shortcuts${shortcutsShortcut ? ` (${shortcutsShortcut})` : ''}`}>
              <button
                type="button"
                className="titlebar__action titlebar__action--text"
                onClick={onShowShortcuts}
                aria-label="Keyboard shortcuts"
                aria-keyshortcuts={shortcutsShortcut ? ariaKeys(shortcutsShortcut) : undefined}
              >
                ?
              </button>
            </Tooltip>
          )}
          {tasks && onToggleTasks && (
            <BackgroundTasks tasks={tasks} active={!!tasksOpen} onToggle={onToggleTasks} />
          )}
          {onTogglePreview && (
            <Tooltip label="Preview: toggle the live preview panel">
              <button
                type="button"
                className={`titlebar__action${previewOpen ? ' titlebar__action--active' : ''}`}
                onClick={onTogglePreview}
                aria-label={
                  previewCount ? `Preview, ${previewCount} server${previewCount === 1 ? '' : 's'} running` : 'Preview'
                }
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
                className={`titlebar__action${filesOpen ? ' titlebar__action--active' : ''}`}
                onClick={onShowFiles}
                aria-label="Files"
                {...(filesOpen !== undefined ? { 'aria-pressed': filesOpen } : {})}
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
                className={`titlebar__action${changesOpen ? ' titlebar__action--active' : ''}`}
                onClick={onShowChanges}
                aria-label={
                  hasChanges ? `Changes, ${changes.fileCount} file${changes.fileCount === 1 ? '' : 's'}` : 'Changes'
                }
                {...(changesOpen !== undefined ? { 'aria-pressed': changesOpen } : {})}
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
                aria-keyshortcuts={terminalShortcut ? ariaKeys(terminalShortcut) : undefined}
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

/** A displayed chord (⌘K, Ctrl+K) in the form aria-keyshortcuts expects (Meta+K, Control+K). */
function ariaKeys(display: string): string {
  const names: Record<string, string> = { '⌘': 'Meta', '⌃': 'Control', '⌥': 'Alt', '⇧': 'Shift', Ctrl: 'Control' }
  const parts = display.includes('+') ? display.split('+') : [...display]
  return parts.map((p) => names[p] ?? p).join('+')
}
