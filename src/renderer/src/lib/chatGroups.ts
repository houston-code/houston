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
  /** The section's top-level chats, in order. Spawned chats nested under a parent are not here. */
  conversations: ConversationMeta[]
  /**
   * Spawned chats nested under their parent, by parent id, in order. A child can
   * itself be a parent (a spawned session that spawned another).
   */
  children: Record<string, ConversationMeta[]>
}

/**
 * Which chats nest under the chat that spawned them. A spawned chat nests when its
 * parent is in `conversations` (so it is shown), unless the user placed the chat
 * themselves: a pinned chat, or one filed into a group, stays where they put it.
 * A parent that was deleted, filtered out by search, or archived away leaves its
 * children at the top level, so a chat never disappears with its parent. A cycle in
 * the (stored, so untrusted) parent links nests nothing on the loop. Pure.
 */
export function nestSpawned(conversations: ConversationMeta[]): {
  /** Chat id → its parent's id, for every chat that nests. */
  parentOf: Map<string, string>
  /** Parent id → its nested children, in the given order. */
  children: Record<string, ConversationMeta[]>
} {
  const byId = new Map(conversations.map((c) => [c.id, c]))
  const candidate = (c: ConversationMeta): string | undefined => {
    const parent = c.spawnedFrom?.conversationId
    if (!parent || parent === c.id || !byId.has(parent) || c.pinned || c.groupId) return undefined
    return parent
  }
  const parentOf = new Map<string, string>()
  for (const c of conversations) {
    const parent = candidate(c)
    if (!parent) continue
    // Walk up the would-be ancestry; a loop back to this chat means a cycle.
    const seen = new Set([c.id])
    let up: string | undefined = parent
    let cycle = false
    while (up) {
      if (seen.has(up)) {
        cycle = true
        break
      }
      seen.add(up)
      const next = byId.get(up)
      up = next ? candidate(next) : undefined
    }
    if (!cycle) parentOf.set(c.id, parent)
  }
  const children: Record<string, ConversationMeta[]> = {}
  for (const c of conversations) {
    const parent = parentOf.get(c.id)
    if (parent) (children[parent] ??= []).push(c)
  }
  for (const list of Object.values(children)) list.sort((a, b) => b.updatedAt - a.updatedAt)
  return { parentOf, children }
}

/** Every chat nested (at any depth) under `id`. */
export function descendantsOf(id: string, children: Record<string, ConversationMeta[]>): ConversationMeta[] {
  const out: ConversationMeta[] = []
  const walk = (pid: string): void => {
    for (const c of children[pid] ?? []) {
      out.push(c)
      walk(c.id)
    }
  }
  walk(id)
  return out
}

/**
 * Order chats within a section. A chat the user has manually placed carries an
 * `order`; those sort by it (ascending). Chats without one — never reordered, or
 * freshly created / moved in — keep recency order and float above the manually
 * arranged block, so a new chat still appears at the top of its section.
 */
const bySectionOrder =
  (recency: (c: ConversationMeta) => number = (c) => c.updatedAt) =>
  (a: ConversationMeta, b: ConversationMeta): number => {
  const ao = a.order
  const bo = b.order
  if (ao == null && bo == null) return recency(b) - recency(a)
  if (ao == null) return -1
  if (bo == null) return 1
  return ao - bo
}

export function buildSidebarSections(
  conversations: ConversationMeta[],
  groups: ChatGroup[],
  /** Collapsed state for the built-in sections ('pinned', 'ungrouped'). */
  collapsedSections: Record<string, boolean> = {},
  /**
   * When given, chats it flags (or whose spawned chats it flags) float to the top of
   * their section, keeping the usual order within each half.
   */
  wantsAttention?: (id: string) => boolean
): SidebarSection[] {
  const groupById = new Map(groups.map((g) => [g.id, g]))
  const pinned: ConversationMeta[] = []
  const byGroup = new Map<string, ConversationMeta[]>()
  const ungrouped: ConversationMeta[] = []
  // Spawned chats nest under their parent wherever it is shown, so they aren't
  // placed in a section of their own.
  const { parentOf, children } = nestSpawned(conversations)
  // A parent sorts by the latest activity anywhere under it, so work happening in a
  // spawned session keeps the chat that started it near the top.
  const latest = new Map<string, number>()
  const recency = (c: ConversationMeta): number => {
    const cached = latest.get(c.id)
    if (cached !== undefined) return cached
    const value = Math.max(c.updatedAt, ...descendantsOf(c.id, children).map((d) => d.updatedAt))
    latest.set(c.id, value)
    return value
  }
  const byRecency = bySectionOrder(recency)
  const flagged = (c: ConversationMeta): boolean =>
    !!wantsAttention &&
    (wantsAttention(c.id) || descendantsOf(c.id, children).some((d) => wantsAttention(d.id)))
  const order = wantsAttention
    ? (a: ConversationMeta, b: ConversationMeta): number =>
        Number(flagged(b)) - Number(flagged(a)) || byRecency(a, b)
    : byRecency

  for (const c of conversations) {
    if (parentOf.has(c.id)) continue
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
      collapsed: collapsedSections.pinned ?? false,
      conversations: pinned.sort(order),
      children
    })
  }

  // Groups always show (even when empty) so chats can be dropped into them.
  for (const g of groups) {
    sections.push({
      kind: 'group',
      id: g.id,
      name: g.name,
      collapsed: g.collapsed ?? false,
      conversations: (byGroup.get(g.id) ?? []).sort(order),
      children
    })
  }

  if (ungrouped.length > 0) {
    sections.push({
      kind: 'ungrouped',
      id: 'ungrouped',
      name: groups.length > 0 || pinned.length > 0 ? 'Ungrouped' : 'Chats',
      collapsed: collapsedSections.ungrouped ?? false,
      conversations: ungrouped.sort(order),
      children
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
