/**
 * The `statusLine` setting's shape and validation, shared by the user's settings and a
 * project's `.houston/settings.json` (where it is part of the trusted, elevating
 * subset). The terminal runs it: see src/main/tui-statusline.ts.
 */

export interface StatusLineConfig {
  command: string
  /** How often to rerun it while the composer is open, in seconds. Absent: only on changes. */
  refreshSeconds?: number
}

/** The shortest refresh interval honored. */
export const STATUS_LINE_MIN_REFRESH_S = 1
/** The longest refresh interval honored. */
export const STATUS_LINE_MAX_REFRESH_S = 3600
/** The longest command accepted. */
const MAX_COMMAND_LENGTH = 4000

/** Validate a `statusLine` value into a config, or null when unusable. */
export function parseStatusLineConfig(raw: unknown): StatusLineConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const { command, refreshSeconds } = raw as Record<string, unknown>
  if (typeof command !== 'string' || !command.trim() || command.length > MAX_COMMAND_LENGTH) return null
  const out: StatusLineConfig = { command: command.trim() }
  if (typeof refreshSeconds === 'number' && Number.isFinite(refreshSeconds) && refreshSeconds > 0) {
    out.refreshSeconds = Math.min(STATUS_LINE_MAX_REFRESH_S, Math.max(STATUS_LINE_MIN_REFRESH_S, Math.round(refreshSeconds)))
  }
  return out
}
