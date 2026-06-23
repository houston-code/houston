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

const byRecency = (a: ConversationMeta, b: ConversationMeta): number => b.updatedAt - a.updatedAt

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
      conversations: pinned.sort(byRecency)
    })
  }

  // Groups always show (even when empty) so chats can be dropped into them.
  for (const g of groups) {
    sections.push({
      kind: 'group',
      id: g.id,
      name: g.name,
      collapsed: g.collapsed ?? false,
      conversations: (byGroup.get(g.id) ?? []).sort(byRecency)
    })
  }

  if (ungrouped.length > 0) {
    sections.push({
      kind: 'ungrouped',
      id: 'ungrouped',
      name: groups.length > 0 || pinned.length > 0 ? 'Ungrouped' : 'Chats',
      collapsed: false,
      conversations: ungrouped.sort(byRecency)
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
