import { describe, expect, it } from 'vitest'
import type { ConversationMeta } from '@shared/agent'
import type { ChatGroup } from '@shared/types'
import { buildSidebarSections, newGroupId } from './chatGroups'

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
})

describe('newGroupId', () => {
  it('generates unique, prefixed ids', () => {
    const a = newGroupId()
    const b = newGroupId()
    expect(a).toMatch(/^grp-/)
    expect(a).not.toBe(b)
  })
})
