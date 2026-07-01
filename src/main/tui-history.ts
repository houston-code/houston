/**
 * Persistent composer history for the interactive TUI. The pure list math lives
 * here; the actual file read/write is injected at the entry point (index.ts),
 * keyed per workspace, so a terminal user's Up/Down recall survives restarts.
 *
 * readline owns in-session Up/Down navigation once its history array is seeded;
 * these helpers just maintain the persisted list.
 */

/** Cap on stored entries, so history can't grow without bound. */
export const HISTORY_CAP = 500

/**
 * Add `line` to history for persistence: trims, skips blanks and a consecutive
 * duplicate of the most recent entry, and caps the total. Returns a new array
 * (most-recent last), leaving the input untouched.
 */
export function appendHistory(line: string, history: string[], cap = HISTORY_CAP): string[] {
  const trimmed = line.trim()
  if (!trimmed) return history
  if (history.length && history[history.length - 1] === trimmed) return history
  const next = [...history, trimmed]
  return next.length > cap ? next.slice(next.length - cap) : next
}

/**
 * Parse a stored history blob (newline-separated) into a list, dropping blanks.
 * Tolerant of a missing/empty file (returns []).
 */
export function parseHistory(raw: string | null | undefined): string[] {
  if (!raw) return []
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-HISTORY_CAP)
}

/** Serialize a history list back to a newline-separated blob for writing. */
export function serializeHistory(history: string[]): string {
  return history.join('\n') + (history.length ? '\n' : '')
}
