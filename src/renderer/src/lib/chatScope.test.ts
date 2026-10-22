import { describe, expect, it } from 'vitest'
import { ownedByChat } from './chatScope'

const items = [
  { id: 'a', conversationId: 'c1' },
  { id: 'b', conversationId: 'c2' },
  { id: 'c' }
]

describe('ownedByChat', () => {
  it("keeps the open chat's items and those no chat owns", () => {
    expect(ownedByChat(items, 'c1').map((i) => i.id)).toEqual(['a', 'c'])
    expect(ownedByChat(items, 'c2').map((i) => i.id)).toEqual(['b', 'c'])
  })

  it('shows only unowned items for a new chat that has no id yet', () => {
    expect(ownedByChat(items, null).map((i) => i.id)).toEqual(['c'])
  })
})
