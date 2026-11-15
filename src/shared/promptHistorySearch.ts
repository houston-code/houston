/**
 * How both clients search the prompts you sent before (the desktop's history search
 * and the terminal's Ctrl-R): case-insensitive, and every space-separated word of
 * the query must appear somewhere in the entry, in any order.
 */

/** Whether `entry` matches `query` (see the module note). An empty query matches everything. */
export function promptMatches(entry: string, query: string): boolean {
  const hay = entry.toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w))
}

/**
 * Sent prompts matching `query`, newest first, at most `limit`. An empty query lists
 * the newest ones. `history` is ordered oldest to newest.
 */
export function searchPromptHistory(history: string[], query: string, limit = 30): string[] {
  const out: string[] = []
  for (let i = history.length - 1; i >= 0 && out.length < limit; i--) {
    if (promptMatches(history[i], query)) out.push(history[i])
  }
  return out
}
