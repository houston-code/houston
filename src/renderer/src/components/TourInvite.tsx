/**
 * One-time banner offering the getting-started tips to installs that predate them.
 * Shown until taken or dismissed; either choice is persisted, so it never returns.
 */
export function TourInvite({
  onTakeTour,
  onDismiss
}: {
  onTakeTour: () => void
  onDismiss: () => void
}): JSX.Element {
  return (
    <div className="update-banner tour-invite" role="status">
      <span className="update-banner__icon" aria-hidden="true">
        ✦
      </span>
      <span className="update-banner__label">
        New: a quick tour of approvals, worktrees, and undo. It takes about a minute.
      </span>
      <button type="button" className="btn btn--sm btn--accent" onClick={onTakeTour}>
        Take the tour
      </button>
      <button
        type="button"
        className="update-banner__dismiss"
        onClick={onDismiss}
        aria-label="Dismiss tour invitation"
        title="Dismiss"
      >
        ✕
      </button>
    </div>
  )
}
