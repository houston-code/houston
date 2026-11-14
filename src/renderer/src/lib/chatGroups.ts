/**
 * Arrange conversations into the sidebar's sections: a "Pinned" section first,
 * then each user-defined group in its configured order, then everything else
 * under "Ungrouped". Pure logic so it can be unit-tested; the Sidebar renders it.
 */
import type { ConversationMeta } from '@shared/agent'
import type { ChatStatusMap } from '@shared/chatStatus'
import type { ChatGroup, SidebarGroupBy } from '@shared/types'
import { baseName, shortenPath } from './paths'

/**
 * 'auto' is one of the automatic sections (a project folder, or a date range) the
 * chats outside any group are split into when the sidebar groups by folder or date.
 * It behaves like Ungrouped: dropping a chat there takes it out of its group.
 */
export type SectionKind = 'pinned' | 'group' | 'ungrouped' | 'auto'

export interface SidebarSection {
  kind: SectionKind
  /** 'pinned' | groupId | 'ungrouped' */
  id: string
  name: string
  collapsed: boolean
  /**
   * The lone Ungrouped list when no group exists: it shows without a header, so
   * nothing could expand it or clear its label filter, and it is never collapsed
   * or filtered.
   */
  headless?: boolean
  /**
   * The section's top-level chats, in order, after its label filter. Spawned chats
   * nested under a parent are not here.
   */
  conversations: ConversationMeta[]
  /** How many top-level chats the section holds before its label filter. */
  total: number
  /** The label ids the section is filtered to (empty = unfiltered). */
  labelFilter: string[]
  /** Every label id carried by a chat in the section (nested chats too), before the filter. */
  labelIds: string[]
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

/**
 * The top-level chats that pass a label filter: each one carrying any of `filter`'s
 * labels, or with a nested chat (at any depth) that does. An empty filter passes all.
 */
export function filterByLabels(
  chats: ConversationMeta[],
  filter: readonly string[],
  children: Record<string, ConversationMeta[]>
): ConversationMeta[] {
  if (filter.length === 0) return chats
  const want = new Set(filter)
  const carries = (c: ConversationMeta): boolean => (c.labels ?? []).some((l) => want.has(l))
  return chats.filter((c) => carries(c) || descendantsOf(c.id, children).some(carries))
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
  wantsAttention?: (id: string) => boolean,
  /** Split the ungrouped chats by project folder or date, as of `now` (ms). */
  autoGroup?: { by: SidebarGroupBy; now: number },
  /**
   * Label filters by section id: a filtered section keeps the top-level chats that
   * carry any of its labels, or that have a nested chat carrying one (the whole tree
   * shows, so a match is never cut off from the chat that spawned it).
   */
  labelFilters: Record<string, string[]> = {}
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
  // Decided once per chat, not on every comparison (each walks the chat's subtree).
  const flaggedIds = new Set(
    wantsAttention
      ? conversations
          .filter((c) => wantsAttention(c.id) || descendantsOf(c.id, children).some((d) => wantsAttention(d.id)))
          .map((c) => c.id)
      : []
  )
  const flagged = (c: ConversationMeta): boolean => flaggedIds.has(c.id)
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
  // One section from its (unfiltered) chats: sorted, then cut down to its label filter.
  const section = (
    kind: SectionKind,
    id: string,
    name: string,
    collapsed: boolean,
    list: ConversationMeta[],
    headless = false
  ): SidebarSection => {
    // A header-less list has no filter button to clear its filter with.
    const filter = headless ? [] : labelFilters[id] ?? []
    const sorted = list.sort(order)
    const labelIds = [
      ...new Set(sorted.flatMap((c) => [c, ...descendantsOf(c.id, children)]).flatMap((c) => c.labels ?? []))
    ]
    return {
      kind,
      id,
      name,
      collapsed,
      ...(headless ? { headless } : {}),
      conversations: filterByLabels(sorted, filter, children),
      total: sorted.length,
      labelFilter: filter,
      labelIds,
      children
    }
  }

  if (pinned.length > 0) {
    sections.push(section('pinned', 'pinned', 'Pinned', collapsedSections.pinned ?? false, pinned))
  }

  // Groups always show (even when empty) so chats can be dropped into them.
  for (const g of groups) {
    sections.push(section('group', g.id, g.name, g.collapsed ?? false, byGroup.get(g.id) ?? []))
  }

  if (ungrouped.length > 0 && autoGroup) {
    for (const auto of autoSections(ungrouped, autoGroup.by, autoGroup.now, recency)) {
      sections.push(
        section('auto', auto.id, auto.name, collapsedSections[auto.id] ?? false, auto.conversations)
      )
    }
  } else if (ungrouped.length > 0) {
    const headless = groups.length === 0
    sections.push(
      section(
        'ungrouped',
        'ungrouped',
        groups.length > 0 || pinned.length > 0 ? 'Ungrouped' : 'Chats',
        !headless && (collapsedSections.ungrouped ?? false),
        ungrouped,
        headless
      )
    )
  }

  return sections
}

/** What the sidebar's layout depends on, named as the Sidebar's own props. */
export interface SidebarLayoutInput {
  conversations: ConversationMeta[]
  groups: ChatGroup[]
  /** Collapsed state for the built-in and automatic sections, by section id. */
  collapsedSections: Record<string, boolean>
  search: string
  chatStatus: ChatStatusMap
  currentId: string | null
  /** Float chats that want attention to the top of each section. */
  unreadFirst?: boolean
  groupBy?: SidebarGroupBy
  /** The current time, for the date sections. */
  now?: number
  /** Label filters by section id. */
  labelFilters?: Record<string, string[]>
}

/**
 * The sections exactly as the Sidebar shows them, for the Sidebar itself and for the
 * keyboard chat-switching that must follow its order, so a chat a label filter hides
 * is skipped like one in a collapsed section. A chat wants attention when it waits on
 * the user or has something unseen (the open chat is being looked at). A search shows
 * every hit, so no section stays collapsed or label-filtered over them.
 */
export function sidebarSections(input: SidebarLayoutInput): SidebarSection[] {
  const { chatStatus, currentId } = input
  const wantsAttention = (id: string): boolean => {
    const st = chatStatus[id]
    return !!st && (st.pending.length > 0 || (st.unread !== undefined && id !== currentId))
  }
  const sections = buildSidebarSections(
    input.conversations,
    input.groups,
    input.collapsedSections,
    input.unreadFirst ? wantsAttention : undefined,
    input.groupBy ? { by: input.groupBy, now: input.now ?? Date.now() } : undefined,
    input.search ? {} : input.labelFilters ?? {}
  )
  return input.search ? sections.map((s) => (s.collapsed ? { ...s, collapsed: false } : s)) : sections
}

/**
 * Whether a parent's spawned chats show under it: unless the user folded them away,
 * and always while one of them is the open chat, so the open chat is never hidden.
 */
export function childrenShown(
  id: string,
  children: Record<string, ConversationMeta[]>,
  collapsedParents: ReadonlySet<string>,
  currentId: string | null
): boolean {
  return !collapsedParents.has(id) || descendantsOf(id, children).some((d) => d.id === currentId)
}

/**
 * The chats in the order the sidebar shows them, top to bottom: Pinned, the groups,
 * then Ungrouped or the automatic sections, each with its spawned chats under it.
 * The rows a collapsed section or a folded parent hides are left out. This is what
 * ⌘1–9 and ⌃Tab step through, so a shortcut lands on the row the user sees.
 */
export function sidebarChatOrder(
  sections: SidebarSection[],
  collapsedParents: ReadonlySet<string>,
  currentId: string | null
): ConversationMeta[] {
  const out: ConversationMeta[] = []
  const walk = (c: ConversationMeta, children: Record<string, ConversationMeta[]>): void => {
    out.push(c)
    const kids = children[c.id] ?? []
    if (kids.length && childrenShown(c.id, children, collapsedParents, currentId)) {
      for (const k of kids) walk(k, children)
    }
  }
  for (const s of sections) {
    if (!s.collapsed) for (const c of s.conversations) walk(c, s.children)
  }
  return out
}

/**
 * The built-in sections' collapsed state after a group is deleted. With no group
 * left, Ungrouped loses its header, so a collapsed flag on it would come back to hide
 * every chat the moment a new group is made; it is dropped instead.
 */
export function collapsedAfterGroupDelete(
  collapsed: Record<string, boolean> | undefined,
  groupsLeft: number
): Record<string, boolean> | undefined {
  if (groupsLeft > 0 || !collapsed?.ungrouped) return collapsed
  const rest = { ...collapsed }
  delete rest.ungrouped
  return rest
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

/** The project folder a chat belongs to: its repository for a worktree chat, else its workspace. */
export function chatFolder(c: ConversationMeta): string {
  return c.worktree?.repoRoot || c.workspace || ''
}

/** The date ranges the sidebar groups by, newest first. */
export const DATE_BUCKETS = [
  { id: 'auto:date:today', name: 'Today' },
  { id: 'auto:date:yesterday', name: 'Yesterday' },
  { id: 'auto:date:week', name: 'This week' },
  { id: 'auto:date:older', name: 'Older' }
] as const

/**
 * Which date range a time falls in, by the local calendar: today, yesterday, the five
 * days before that (this week, meaning the last seven days), or older.
 */
export function dateBucket(at: number, now: number): (typeof DATE_BUCKETS)[number]['id'] {
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  const today = day.getTime()
  day.setDate(day.getDate() - 1)
  const yesterday = day.getTime()
  day.setDate(day.getDate() - 5)
  const week = day.getTime()
  if (at >= today) return 'auto:date:today'
  if (at >= yesterday) return 'auto:date:yesterday'
  if (at >= week) return 'auto:date:week'
  return 'auto:date:older'
}

/**
 * The automatic section a chat outside any group lands in: its project folder, or the
 * date range of its latest activity (`recency`, which counts its spawned chats).
 */
export function autoSectionId(
  c: ConversationMeta,
  by: SidebarGroupBy,
  now: number,
  recency: (c: ConversationMeta) => number = (c) => c.updatedAt
): string {
  return by === 'date' ? dateBucket(recency(c), now) : `auto:folder:${chatFolder(c)}`
}

/**
 * Split chats into automatic sections. By folder: one section per project folder,
 * named for it (with its parent folders when two share a name), the most recently
 * active first. By date: Today, Yesterday, This week, Older, skipping empty ones. A
 * chat's date is its latest activity, its spawned chats included. Pure.
 */
export function autoSections(
  chats: ConversationMeta[],
  by: SidebarGroupBy,
  now: number,
  recency: (c: ConversationMeta) => number = (c) => c.updatedAt
): { id: string; name: string; conversations: ConversationMeta[] }[] {
  if (by === 'date') {
    const buckets = new Map<string, ConversationMeta[]>()
    for (const c of chats) {
      const id = autoSectionId(c, by, now, recency)
      buckets.set(id, [...(buckets.get(id) ?? []), c])
    }
    return DATE_BUCKETS.filter((b) => buckets.has(b.id)).map((b) => ({
      id: b.id,
      name: b.name,
      conversations: buckets.get(b.id)!
    }))
  }
  const byFolder = new Map<string, ConversationMeta[]>()
  for (const c of chats) {
    const folder = chatFolder(c)
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), c])
  }
  const names = new Map<string, number>()
  for (const folder of byFolder.keys()) {
    const name = folder ? baseName(folder) : ''
    names.set(name, (names.get(name) ?? 0) + 1)
  }
  const latest = (list: ConversationMeta[]): number => Math.max(...list.map(recency))
  return [...byFolder]
    .sort(([, a], [, b]) => latest(b) - latest(a))
    .map(([folder, conversations]) => {
      const name = folder ? baseName(folder) : 'No folder'
      return {
        id: `auto:folder:${folder}`,
        name: folder && (names.get(name) ?? 0) > 1 ? shortenPath(folder, 2) : name,
        conversations
      }
    })
}
