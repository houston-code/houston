import { chooseShipAction, type ShipAction } from '@shared/shipAction'
import type { WorkingTreeStats } from '../hooks/useWorkingTreeStats'

/**
 * A slim bar at the top of the composer, shown only when the working tree has
 * uncommitted changes. The left chip ("N changed files +A −R") is clickable and
 * opens the Changes panel; the right button hands shipping to the agent (the
 * same action as the Changes-panel footer button — both entry points are kept).
 * The button follows the repo's state: "Create PR" needs commits and a GitHub
 * remote, so a fresh repo gets "Publish to GitHub" instead (see chooseShipAction).
 * Renders nothing when there are no changes.
 */
export function ComposerPrBar({
  changes,
  onShowChanges,
  onShip,
  creating = false
}: {
  changes: WorkingTreeStats
  onShowChanges: () => void
  onShip: (action: ShipAction) => void
  /** True while a run is in progress — sending now would clobber it, so disable. */
  creating?: boolean
}): JSX.Element | null {
  const { fileCount, added, removed } = changes
  if (fileCount === 0) return null
  const action = chooseShipAction(changes.ship)
  return (
    <div className="composer__pr-bar">
      <button
        type="button"
        className="composer__pr-stat"
        onClick={onShowChanges}
        title="View working-tree changes"
      >
        <span className="composer__pr-files">
          {fileCount} changed file{fileCount === 1 ? '' : 's'}
        </span>
        {(added > 0 || removed > 0) && (
          <span className="diff-stat">
            <span className="diff-stat__add">+{added}</span>
            <span className="diff-stat__del">−{removed}</span>
          </span>
        )}
      </button>
      <button
        type="button"
        className="btn btn--sm btn--accent"
        onClick={() => onShip(action)}
        disabled={creating}
        title={creating ? 'Wait for the current run to finish' : action.title}
      >
        {action.label}
      </button>
    </div>
  )
}
