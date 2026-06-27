/**
 * Arrange conversations into the sidebar's sections: a "Pinned" section first,
 * then each user-defined group in its configured order, then everything else
 * under "Ungrouped". Pure logic so it can be unit-tested; the Sidebar renders it.
 */
import type { ConversationMeta } from '@shared/agent'
import type { ChatGroup } from '@shared/types'

export type SectionKind = 'pinned' | 'group' | 'ungrouped'

export interface SidebarSection {
  kind: SectionKind
  /** 'pinned' | groupId | 'ungrouped' */
  id: string
  name: string
  collapsed: boolean
  conversations: ConversationMeta[]
}

/**
 * Order chats within a section. A chat the user has manually placed carries an
 * `order`; those sort by it (ascending). Chats without one — never reordered, or
 * freshly created / moved in — keep recency order and float above the manually
 * arranged block, so a new chat still appears at the top of its section.
 */
const bySectionOrder = (a: ConversationMeta, b: ConversationMeta): number => {
  const ao = a.order
  const bo = b.order
  if (ao == null && bo == null) return b.updatedAt - a.updatedAt
  if (ao == null) return -1
  if (bo == null) return 1
  return ao - bo
}

export function buildSidebarSections(
  conversations: ConversationMeta[],
  groups: ChatGroup[]
): SidebarSection[] {
  const groupById = new Map(groups.map((g) => [g.id, g]))
  const pinned: ConversationMeta[] = []
  const byGroup = new Map<string, ConversationMeta[]>()
  const ungrouped: ConversationMeta[] = []

  for (const c of conversations) {
    if (c.pinned) {
      pinned.push(c)
      continue
    }
    // A groupId that no longer maps to a known group falls back to ungrouped.
    if (c.groupId && groupById.has(c.groupId)) {
      const list = byGroup.get(c.groupId) ?? []
      list.push(c)
      byGroup.set(c.groupId, list)
    } else {
      ungrouped.push(c)
    }
  }

  const sections: SidebarSection[] = []

  if (pinned.length > 0) {
    sections.push({
      kind: 'pinned',
      id: 'pinned',
      name: 'Pinned',
      collapsed: false,
      conversations: pinned.sort(bySectionOrder)
    })
  }

  // Groups always show (even when empty) so chats can be dropped into them.
  for (const g of groups) {
    sections.push({
      kind: 'group',
      id: g.id,
      name: g.name,
      collapsed: g.collapsed ?? false,
      conversations: (byGroup.get(g.id) ?? []).sort(bySectionOrder)
    })
  }

  if (ungrouped.length > 0) {
    sections.push({
      kind: 'ungrouped',
      id: 'ungrouped',
      name: groups.length > 0 || pinned.length > 0 ? 'Ungrouped' : 'Chats',
      collapsed: false,
      conversations: ungrouped.sort(bySectionOrder)
    })
  }

  return sections
}

/**
 * Generate a unique id for a new group. We never reuse ids (e.g. a reusable
 * counter) because a deleted-then-recreated group could otherwise reclaim chats
 * still tagged with the old id.
 */
export function newGroupId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto
  if (c && typeof c.randomUUID === 'function') return `grp-${c.randomUUID()}`
  return `grp-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`
}

/**
 * Compute the new id order for a section after dropping `draggedId` at the
 * visual slot `dropIndex` (0..length, where length means "after the last row").
 * `dropIndex` is measured against the section as currently rendered (which may
 * already contain the dragged row), so we remove the chat first, then translate
 * the slot to account for that removal. Works for both same-section reorders
 * (the chat is in `currentIds`) and cross-section moves (it is not).
 */
export function reorderedIds(
  currentIds: string[],
  draggedId: string,
  dropIndex: number
): string[] {
  const from = currentIds.indexOf(draggedId)
  const without = currentIds.filter((id) => id !== draggedId)
  // A target slot past the dragged row shifts down by one once the row is removed.
  let to = from !== -1 && dropIndex > from ? dropIndex - 1 : dropIndex
  to = Math.max(0, Math.min(to, without.length))
  without.splice(to, 0, draggedId)
  return without
}

/**
 * Given the bounding rects of a section's rows (in render order) and a pointer
 * Y, return the slot a drop would land in: the index of the first row whose
 * vertical midpoint is below the pointer, or `rects.length` when the pointer is
 * past every row (drop at the end / into empty space).
 */
export function dropIndexForY(rects: { top: number; height: number }[], clientY: number): number {
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]
    if (clientY < r.top + r.height / 2) return i
  }
  return rects.length
}
