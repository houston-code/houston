/** Sizing for the docked plan-review panel (width in px). */
export const PLAN_MIN_WIDTH = 320
export const PLAN_MAX_WIDTH = 720
export const PLAN_DEFAULT_WIDTH = 440

/** Clamp a candidate panel width into the allowed range. */
export function clampPlanWidth(px: number): number {
  return Math.max(PLAN_MIN_WIDTH, Math.min(PLAN_MAX_WIDTH, Math.round(px)))
}
