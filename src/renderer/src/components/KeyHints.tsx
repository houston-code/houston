/**
 * A quiet row of keys under the message box on an empty chat, so the composer's
 * characters and shortcuts can be found without opening the shortcut sheet. Hidden
 * once the chat has messages, to keep a working chat uncluttered.
 */
export function KeyHints({ hints }: { hints: readonly { keys: string; does: string }[] }): JSX.Element {
  return (
    <p className="key-hints" aria-label="Keyboard hints">
      {hints.map((h) => (
        <span key={h.does} className="key-hints__item">
          <kbd className="key-hints__key">{h.keys}</kbd> {h.does}
        </span>
      ))}
    </p>
  )
}

/** The hints, with the rebindable keys shown as the user has them bound. */
export function keyHintList(keys: { palette?: string; cycleMode?: string }): { keys: string; does: string }[] {
  return [
    { keys: '/', does: 'commands' },
    { keys: '@', does: 'files' },
    { keys: '#', does: 'save a rule' },
    ...(keys.cycleMode ? [{ keys: keys.cycleMode, does: 'switch mode' }] : []),
    { keys: '↑', does: 'last prompt' },
    ...(keys.palette ? [{ keys: keys.palette, does: 'everything else' }] : [])
  ]
}
