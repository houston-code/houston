import { describe, expect, it } from 'vitest'
import type { ConversationMeta } from '@shared/agent'
import type { ChatGroup } from '@shared/types'
import { buildSidebarSections, dropIndexForY, newGroupId, reorderedIds } from './chatGroups'

function conv(id: string, updatedAt: number, extra: Partial<ConversationMeta> = {}): ConversationMeta {
  return {
    id,
    title: id,
    workspace: '/ws',
    providerId: 'p',
    model: 'm',
    createdAt: updatedAt,
    updatedAt,
    ...extra
  }
}

describe('buildSidebarSections', () => {
  it('returns a single "Chats" section when there are no groups or pins', () => {
    const sections = buildSidebarSections([conv('a', 2), conv('b', 1)], [])
    expect(sections).toHaveLength(1)
    expect(sections[0]).toMatchObject({ kind: 'ungrouped', name: 'Chats' })
    expect(sections[0].conversations.map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('floats pinned chats into a Pinned section at the top', () => {
    const sections = buildSidebarSections(
      [conv('a', 3), conv('b', 2, { pinned: true }), conv('c', 1)],
      []
    )
    expect(sections.map((s) => s.kind)).toEqual(['pinned', 'ungrouped'])
    expect(sections[0].conversations.map((c) => c.id)).toEqual(['b'])
    expect(sections[1].conversations.map((c) => c.id)).toEqual(['a', 'c'])
  })

  it('places chats into their groups, in group order, and shows empty groups', () => {
    const groups: ChatGroup[] = [
      { id: 'g1', name: 'Backend' },
      { id: 'g2', name: 'Frontend' }
    ]
    const sections = buildSidebarSections(
      [conv('a', 5, { groupId: 'g1' }), conv('b', 4, { groupId: 'g1' }), conv('c', 3)],
      groups
    )
    expect(sections.map((s) => s.name)).toEqual(['Backend', 'Frontend', 'Ungrouped'])
    expect(sections[0].conversations.map((c) => c.id)).toEqual(['a', 'b'])
    expect(sections[1].conversations).toHaveLength(0) // empty group still shown
    expect(sections[2].conversations.map((c) => c.id)).toEqual(['c'])
  })

  it('treats an unknown groupId as ungrouped', () => {
    const sections = buildSidebarSections([conv('a', 1, { groupId: 'gone' })], [
      { id: 'g1', name: 'Real' }
    ])
    expect(sections.find((s) => s.kind === 'ungrouped')?.conversations.map((c) => c.id)).toEqual([
      'a'
    ])
  })

  it('pinning wins over group membership', () => {
    const sections = buildSidebarSections(
      [conv('a', 1, { groupId: 'g1', pinned: true })],
      [{ id: 'g1', name: 'G' }]
    )
    expect(sections.find((s) => s.kind === 'pinned')?.conversations.map((c) => c.id)).toEqual(['a'])
    expect(sections.find((s) => s.id === 'g1')?.conversations).toHaveLength(0)
  })

  it('reflects a group\'s collapsed flag', () => {
    const sections = buildSidebarSections([], [{ id: 'g1', name: 'G', collapsed: true }])
    expect(sections[0].collapsed).toBe(true)
  })

  it('reflects collapsedSections for the built-in pinned and ungrouped sections', () => {
    const sections = buildSidebarSections(
      [conv('a', 2, { pinned: true }), conv('b', 1)],
      [],
      { pinned: true, ungrouped: false }
    )
    expect(sections.find((s) => s.kind === 'pinned')?.collapsed).toBe(true)
    expect(sections.find((s) => s.kind === 'ungrouped')?.collapsed).toBe(false)
  })

  it('defaults built-in sections to expanded when no collapsed state is given', () => {
    const sections = buildSidebarSections([conv('a', 1, { pinned: true }), conv('b', 1)], [])
    expect(sections.every((s) => !s.collapsed)).toBe(true)
  })

  it('sorts manually-ordered chats by their order, ascending', () => {
    // Despite recency (c newest), the manual order wins: a(0), b(1), c(2).
    const sections = buildSidebarSections(
      [
        conv('a', 1, { order: 0 }),
        conv('b', 2, { order: 1 }),
        conv('c', 3, { order: 2 })
      ],
      []
    )
    expect(sections[0].conversations.map((c) => c.id)).toEqual(['a', 'b', 'c'])
  })

  it('floats an un-ordered chat above the manually-ordered block (by recency)', () => {
    // `n` has no order (e.g. just created) and sorts above the arranged a/b.
    const sections = buildSidebarSections(
      [conv('a', 1, { order: 0 }), conv('b', 2, { order: 1 }), conv('n', 5)],
      []
    )
    expect(sections[0].conversations.map((c) => c.id)).toEqual(['n', 'a', 'b'])
  })
})

describe('reorderedIds', () => {
  it('moves a chat up within the same section', () => {
    expect(reorderedIds(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b'])
  })

  it('moves a chat down (slot past the dragged row shifts by one)', () => {
    expect(reorderedIds(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'a', 'c'])
  })

  it('is a no-op when dropped onto its own slot', () => {
    expect(reorderedIds(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'b', 'c'])
    expect(reorderedIds(['a', 'b', 'c'], 'b', 2)).toEqual(['a', 'b', 'c'])
  })

  it('inserts a chat dragged in from another section at the slot', () => {
    expect(reorderedIds(['a', 'b'], 'x', 1)).toEqual(['a', 'x', 'b'])
    expect(reorderedIds(['a', 'b'], 'x', 0)).toEqual(['x', 'a', 'b'])
    expect(reorderedIds([], 'x', 0)).toEqual(['x'])
  })

  it('clamps an out-of-range slot to the ends', () => {
    expect(reorderedIds(['a', 'b'], 'x', 99)).toEqual(['a', 'b', 'x'])
  })
})

describe('dropIndexForY', () => {
  const rects = [
    { top: 0, height: 40 },
    { top: 40, height: 40 },
    { top: 80, height: 40 }
  ]

  it('returns the slot above the row whose midpoint is below the pointer', () => {
    expect(dropIndexForY(rects, 5)).toBe(0) // above row 0's midpoint (20)
    expect(dropIndexForY(rects, 30)).toBe(1) // past row 0, above row 1's midpoint (60)
    expect(dropIndexForY(rects, 70)).toBe(2)
  })

  it('returns the end index when the pointer is past every row', () => {
    expect(dropIndexForY(rects, 200)).toBe(3)
    expect(dropIndexForY([], 0)).toBe(0)
  })
})

describe('newGroupId', () => {
  it('generates unique, prefixed ids', () => {
    const a = newGroupId()
    const b = newGroupId()
    expect(a).toMatch(/^grp-/)
    expect(a).not.toBe(b)
  })
})
