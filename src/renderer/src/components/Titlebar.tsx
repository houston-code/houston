/**
 * A slim, draggable strip at the top of the main pane. With the window's
 * `hiddenInset` traffic lights it keeps the top of the window draggable (the
 * sidebar covers the left), and shows the current chat's title for context now
 * that the model/mode controls live in the bottom bar. An optional "Changes"
 * action opens the working-tree diff panel.
 */
export function Titlebar({
  title,
  onShowChanges
}: {
  title: string
  onShowChanges?: () => void
}): JSX.Element {
  return (
    <header className="titlebar">
      <span className="titlebar__title">{title}</span>
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
    </header>
  )
}
