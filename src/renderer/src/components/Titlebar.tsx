/**
 * A slim, draggable strip at the top of the main pane. With the window's
 * `hiddenInset` traffic lights it keeps the top of the window draggable (the
 * sidebar covers the left), and shows the current chat's title for context now
 * that the model/mode controls live in the bottom bar. Top-right actions open the
 * working-tree diff panel and toggle the integrated terminal.
 */
export function Titlebar({
  title,
  onShowChanges,
  onToggleTerminal,
  terminalOpen
}: {
  title: string
  onShowChanges?: () => void
  onToggleTerminal?: () => void
  terminalOpen?: boolean
}): JSX.Element {
  return (
    <header className="titlebar">
      <span className="titlebar__title">{title}</span>
      <div className="titlebar__actions">
        {onShowChanges && (
          <button
            type="button"
            className="titlebar__action"
            onClick={onShowChanges}
            title="View uncommitted working-tree changes"
          >
            ⤓ Changes
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
