/**
 * Sidebar sizing. Kept here as pure constants + a clamp helper so the layout
 * math is testable and shared between the drag handle, the keyboard nudge, and
 * the persisted-width restore on launch.
 */

/** Default sidebar width (px) — the historical fixed column width. */
export const SIDEBAR_DEFAULT_WIDTH = 248
/** Narrowest the sidebar can be dragged before it stops shrinking. */
export const SIDEBAR_MIN_WIDTH = 200
/** Widest the sidebar can be dragged, so it can't crowd out the chat pane. */
export const SIDEBAR_MAX_WIDTH = 480
/** Width (px) of the collapsed rail. */
export const SIDEBAR_RAIL_WIDTH = 48
/** How far an arrow-key press nudges the width when the handle is focused. */
export const SIDEBAR_NUDGE_STEP = 16
/**
 * Dragging narrower than this (below the min) snaps to the collapsed rail, so a
 * hard drag to the left feels like "hide it" rather than getting stuck at min.
 */
export const SIDEBAR_COLLAPSE_AT = SIDEBAR_MIN_WIDTH - 40

/** Clamp an arbitrary width to the allowed range and round to a whole pixel. */
export function clampSidebarWidth(px: number): number {
  if (!Number.isFinite(px)) return SIDEBAR_DEFAULT_WIDTH
  return Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, px)))
}
