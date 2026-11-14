import type { AppSettings } from '@shared/types'

/**
 * Accessibility modes for the interactive terminal, decided once at launch from the
 * environment and the saved settings. Pure, so the precedence is testable.
 */

/** The spinner's refresh interval with reduced motion on: the timer, not an animation. */
export const REDUCED_MOTION_REFRESH_MS = 5000

/** The still mark the activity line shows in place of the spinner's frames. */
export const STATIC_SPINNER_GLYPH = '•'

/** An environment switch: `1`, `true`, `yes` or `on` (any case) turns it on. */
export function envFlag(value: string | undefined): boolean {
  return value !== undefined && /^(1|true|yes|on)$/i.test(value.trim())
}

export interface AccessibilityModes {
  reduceMotion: boolean
}

/** Reduced motion is on with `HOUSTON_REDUCE_MOTION` or the saved setting. */
export function resolveAccessibility(
  env: NodeJS.ProcessEnv,
  settings: Pick<AppSettings, 'reduceMotion'>
): AccessibilityModes {
  return { reduceMotion: envFlag(env.HOUSTON_REDUCE_MOTION) || settings.reduceMotion === true }
}
