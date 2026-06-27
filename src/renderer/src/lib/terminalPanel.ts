/** Sizing for the integrated terminal panel (height in px). */
export const TERMINAL_MIN_HEIGHT = 120
export const TERMINAL_MAX_HEIGHT = 700
export const TERMINAL_DEFAULT_HEIGHT = 260

/** Clamp a candidate panel height into the allowed range. */
export function clampTerminalHeight(px: number): number {
  return Math.max(TERMINAL_MIN_HEIGHT, Math.min(TERMINAL_MAX_HEIGHT, Math.round(px)))
}
