/**
 * Pure helpers for keyboard chat-switching: pick the Nth chat (⌘1–9) or step to the
 * next/previous one (⌃Tab / ⌃⇧Tab), over whatever list is currently visible.
 */

interface HasId {
  id: string
}

/** The id at `index` in the list, or null if out of range. */
export function chatAtIndex(list: readonly HasId[], index: number): string | null {
  return index >= 0 && index < list.length ? list[index].id : null
}

/**
 * The id one step from `currentId` in `dir` (+1 next, -1 previous), wrapping around.
 * Falls back to an end of the list when the current id isn't present, and returns
 * null for an empty list.
 */
export function cycleChatId(
  list: readonly HasId[],
  currentId: string | null,
  dir: 1 | -1
): string | null {
  if (list.length === 0) return null
  const idx = list.findIndex((c) => c.id === currentId)
  if (idx === -1) return dir === 1 ? list[0].id : list[list.length - 1].id
  const next = (idx + dir + list.length) % list.length
  return list[next].id
}
