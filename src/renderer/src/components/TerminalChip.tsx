import { Icon } from './Icon'
import { Tooltip } from './Tooltip'

/**
 * Status-bar chip that brings a minimized terminal panel back. Hiding the panel
 * keeps its shells alive, but nothing near the bottom edge said so; this chip sits
 * where the panel went (just before the model name) while there are open terminal
 * tabs and the panel is hidden. It renders nothing otherwise.
 */
export function TerminalChip({
  tabCount,
  open,
  shortcut,
  onShow
}: {
  /** Open integrated-terminal tabs. */
  tabCount: number
  /** The terminal panel is showing. */
  open: boolean
  /** The toggle's shortcut as displayed on this platform (e.g. ⌃`, Ctrl+`). */
  shortcut?: string
  onShow: () => void
}): JSX.Element | null {
  if (open || tabCount === 0) return null
  return (
    <Tooltip label={`Show terminal${shortcut ? ` (${shortcut})` : ''}`}>
      <button
        type="button"
        className="statusbar__terminal"
        aria-label={`Show terminal, ${tabCount} ${tabCount === 1 ? 'tab' : 'tabs'}`}
        onClick={onShow}
      >
        <Icon name="terminal" size={12} />
        <span>Terminal · {tabCount}</span>
        <Icon name="chevronRight" size={10} className="statusbar__terminal-chevron" />
      </button>
    </Tooltip>
  )
}
