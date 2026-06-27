import { useCallback, useEffect, useRef } from 'react'
import { useTerminals } from '../hooks/useTerminals'
import { TerminalView } from './TerminalView'

/**
 * The integrated terminal panel: a resizable strip docked above the composer with
 * a tab bar and one xterm view per tab. Lazy-loaded (xterm.js is heavy) so it
 * only enters the bundle when the user first opens the terminal.
 *
 * It stays mounted once opened and is hidden via `visible` (CSS display) rather
 * than unmounted, so terminal sessions and scrollback survive hide/show. Height
 * is owned by App (persisted to settings); the top edge is a drag handle.
 */
export function TerminalDock({
  workspace,
  visible,
  onResizeMouseDown,
  onClose
}: {
  workspace: string | null
  visible: boolean
  onResizeMouseDown: (e: React.MouseEvent) => void
  onClose: () => void
}): JSX.Element {
  const { tabs, activeId, addTab, closeTab, setActive } = useTerminals(workspace)
  // Guards against double-spawning while the async addTab is in flight.
  const opening = useRef(false)

  // Ensure there's a terminal whenever the panel is shown and empty — covers the
  // first open and reopening after every tab was closed.
  useEffect(() => {
    if (visible && tabs.length === 0 && !opening.current) {
      opening.current = true
      void addTab().finally(() => {
        opening.current = false
      })
    }
  }, [visible, tabs.length, addTab])

  // Close a tab; if it was the last one, hide the whole panel instead of leaving
  // an empty shell (reopening will spawn a fresh terminal).
  const handleCloseTab = useCallback(
    (id: string) => {
      const wasLast = tabs.length <= 1
      closeTab(id)
      if (wasLast) onClose()
    },
    [tabs.length, closeTab, onClose]
  )

  // ⌘W while the terminal is focused: main asks us to close the active tab.
  useEffect(() => {
    return window.api.onTerminalCloseActive(() => {
      if (activeId) handleCloseTab(activeId)
    })
  }, [activeId, handleCloseTab])

  // The terminal is only a ⌘W target when it's actually on screen with a tab.
  // Authoritatively clear the focus flag whenever the panel is hidden or empty —
  // removing a focused xterm from the DOM doesn't reliably fire a bubbling blur,
  // which would otherwise leave the flag stuck true and make ⌘W (with no terminal
  // open) try to close a non-existent tab instead of the window.
  useEffect(() => {
    if (!visible || tabs.length === 0) window.api.setTerminalFocused(false)
  }, [visible, tabs.length])

  return (
    <div
      className="terminal-dock"
      style={{ display: visible ? 'flex' : 'none' }}
      // Report focus to main so ⌘W routes to the active tab while typing here.
      onFocus={() => window.api.setTerminalFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          window.api.setTerminalFocused(false)
        }
      }}
    >
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
                  handleCloseTab(t.id)
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
              {/* "active" drives focus/refit; gate on panel visibility so a hidden
                  panel never steals focus and a reshown one refits to its size. */}
              <TerminalView id={t.id} active={visible && t.id === activeId} />
            </div>
          ))
        )}
      </div>
    </div>
  )
}
