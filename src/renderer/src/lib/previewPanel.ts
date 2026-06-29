/** Sizing for the right-hand preview panel (width in px). */
export const PREVIEW_MIN_WIDTH = 280
export const PREVIEW_MAX_WIDTH = 900
export const PREVIEW_DEFAULT_WIDTH = 420

/** Clamp a candidate panel width into the allowed range. */
export function clampPreviewWidth(px: number): number {
  return Math.max(PREVIEW_MIN_WIDTH, Math.min(PREVIEW_MAX_WIDTH, Math.round(px)))
}
