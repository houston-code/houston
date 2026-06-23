/**
 * A slim, draggable strip at the top of the main pane. With the window's
 * `hiddenInset` traffic lights it keeps the top of the window draggable (the
 * sidebar covers the left), and shows the current chat's title for context now
 * that the model/mode controls live in the bottom bar.
 */
export function Titlebar({ title }: { title: string }): JSX.Element {
  return (
    <header className="titlebar">
      <span className="titlebar__title">{title}</span>
    </header>
  )
}
