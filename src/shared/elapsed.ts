/**
 * How long a turn has been running, as both clients show it while it works: whole
 * seconds ("0s", "42s"), then minutes ("3m 12s"), then hours ("1h 4m"). Whole seconds
 * because the figure ticks once a second; a fraction would flicker and say nothing.
 * Pure so the terminal spinner and the desktop status bar share one wording.
 */
export function formatElapsed(ms: number): string {
  const s = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}
