import { useEffect } from 'react'
import { useTerminals } from '../hooks/useTerminals'
import { TerminalView } from './TerminalView'

/**
 * The integrated terminal panel: a resizable strip docked above the composer with
 * a tab bar and one xterm view per tab. Lazy-loaded (xterm.js is heavy) so it
 * only enters the bundle when the user first opens the terminal.
 *
 * Height is owned by App (persisted to settings); the top edge is a drag handle
 * that calls back into App's resize logic.
 */
export function TerminalDock({
  workspace,
  onResizeMouseDown,
  onClose
}: {
  workspace: string | null
  onResizeMouseDown: (e: React.MouseEvent) => void
  onClose: () => void
}): JSX.Element {
  const { tabs, activeId, addTab, closeTab, setActive } = useTerminals(workspace)

  // Open a first terminal automatically when the panel mounts with none.
  useEffect(() => {
    if (tabs.length === 0) void addTab()
    // Only on mount — afterwards the user manages tabs explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="terminal-dock">
      <div
        className="terminal-dock__resizer"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize terminal panel"
        onMouseDown={onResizeMouseDown}
      />
      <div className="terminal-dock__tabs">
        <div className="terminal-dock__tablist" role="tablist">
          {tabs.map((t) => (
            <div
              key={t.id}
              role="tab"
              aria-selected={t.id === activeId}
              className={`terminal-tab${t.id === activeId ? ' terminal-tab--active' : ''}${
                t.exited ? ' terminal-tab--exited' : ''
              }`}
              onClick={() => setActive(t.id)}
            >
              <span className="terminal-tab__title">
                {t.title}
                {t.exited ? ' (exited)' : ''}
              </span>
              <button
                type="button"
                className="terminal-tab__close"
                title="Close terminal"
                aria-label={`Close ${t.title}`}
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(t.id)
                }}
              >
                ✕
              </button>
            </div>
          ))}
          <button
            type="button"
            className="terminal-dock__add"
            title="New terminal"
            aria-label="New terminal"
            onClick={() => void addTab()}
          >
            +
          </button>
        </div>
        <button
          type="button"
          className="terminal-dock__hide"
          title="Hide terminal panel"
          aria-label="Hide terminal panel"
          onClick={onClose}
        >
          ⌄
        </button>
      </div>
      <div className="terminal-dock__body">
        {tabs.length === 0 ? (
          <div className="terminal-dock__empty">No terminals open.</div>
        ) : (
          tabs.map((t) => (
            // Keep every tab mounted; hide inactive ones so their session persists.
            <div
              key={t.id}
              className="terminal-dock__pane"
              style={{ display: t.id === activeId ? 'block' : 'none' }}
            >
              <TerminalView id={t.id} active={t.id === activeId} />
            </div>
          ))
        )}
      </div>
    </div>
  )
}
