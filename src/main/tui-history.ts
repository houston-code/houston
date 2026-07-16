/**
 * Persistent composer history for the interactive TUI. The pure list math lives
 * here; the actual file read/write is injected at the entry point (index.ts),
 * keyed per workspace, so a terminal user's Up/Down recall survives restarts.
 *
 * The composer's editor model owns in-session Up/Down navigation and Ctrl-R
 * search (tui-editor.ts); these helpers just maintain the persisted list.
 *
 * The store is one entry per file line, so a multi-line entry has to be escaped:
 * stored raw, a pasted block would read back as several bogus one-line entries
 * (and recalling it would replay only its first line).
 */

/** Cap on stored entries, so history can't grow without bound. */
export const HISTORY_CAP = 500

/** Escape an entry to a single storable line (`\` → `\\`, newline → `\n`). */
export function encodeHistoryLine(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')
}

/** Reverse `encodeHistoryLine`. Unknown escapes decode to the character itself. */
export function decodeHistoryLine(s: string): string {
  return s.replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c))
}

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
 * Parse a stored history blob (one escaped entry per line) into a list, dropping
 * blanks. Tolerant of a missing/empty file (returns []).
 */
export function parseHistory(raw: string | null | undefined): string[] {
  if (!raw) return []
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map(decodeHistoryLine)
    .slice(-HISTORY_CAP)
}

/** Serialize a history list back to a blob for writing (one escaped entry per line). */
export function serializeHistory(history: string[]): string {
  return history.map(encodeHistoryLine).join('\n') + (history.length ? '\n' : '')
}
