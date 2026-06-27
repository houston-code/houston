/**
 * A small persisted ring of recently submitted prompts, so the composer can recall
 * them with Up/Down (the way a shell or every coding agent does). Stored in
 * localStorage — renderer-only, no main-process round-trip needed.
 *
 * The list is ordered oldest → newest. Navigation indexes run `0..length`, where
 * `length` is the sentinel for "the live draft" (not yet in history).
 */

const KEY = 'houston.promptHistory'
const MAX = 100

/** Load the saved history, tolerating absent/corrupt storage (→ empty list). */
export function loadPromptHistory(): string[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is string => typeof x === 'string')
  } catch {
    return []
  }
}

/**
 * Record a submitted prompt as the newest entry and return the updated list.
 * Blank prompts are ignored; an exact duplicate is moved to the end rather than
 * stored twice; the list is capped at {@link MAX} (oldest dropped).
 */
export function appendPromptHistory(text: string): string[] {
  const entry = text.trim()
  if (!entry) return loadPromptHistory()
  const next = loadPromptHistory().filter((e) => e !== entry)
  next.push(entry)
  const capped = next.slice(-MAX)
  try {
    localStorage.setItem(KEY, JSON.stringify(capped))
  } catch {
    // Storage full or unavailable — recall just won't persist; not worth surfacing.
  }
  return capped
}

/** Index after pressing Up (older). Clamps at the oldest entry. */
export function historyUp(length: number, index: number): number {
  if (length === 0) return index
  return Math.max(0, index - 1)
}

/** Index after pressing Down (newer). Returns `length` (the live draft) past the newest. */
export function historyDown(length: number, index: number): number {
  return Math.min(length, index + 1)
}
