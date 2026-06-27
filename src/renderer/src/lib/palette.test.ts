import { describe, it, expect } from 'vitest'
import { filterPalette, type PaletteItem } from './palette'

const item = (over: Partial<PaletteItem> & { id: string; title: string }): PaletteItem => ({
  section: 'Actions',
  run: () => {},
  ...over
})

const items: PaletteItem[] = [
  item({ id: 'new', title: 'New chat', keywords: 'create start' }),
  item({ id: 'settings', title: 'Open settings' }),
  item({ id: 'mode-plan', title: 'Plan mode', section: 'Approval' }),
  item({ id: 'chat-1', title: 'Fix login bug', section: 'Switch chat', subtitle: 'acme-web' })
]

describe('filterPalette', () => {
  it('returns everything for an empty query, order preserved', () => {
    expect(filterPalette(items, '').map((i) => i.id)).toEqual(['new', 'settings', 'mode-plan', 'chat-1'])
    expect(filterPalette(items, '   ')).toHaveLength(4)
  })

  it('matches case-insensitively on the title', () => {
    expect(filterPalette(items, 'PLAN').map((i) => i.id)).toEqual(['mode-plan'])
  })

  it('requires every whitespace-split token to match (AND)', () => {
    expect(filterPalette(items, 'fix bug').map((i) => i.id)).toEqual(['chat-1'])
    expect(filterPalette(items, 'fix settings')).toHaveLength(0)
  })

  it('searches keywords, subtitle and section as well as the title', () => {
    expect(filterPalette(items, 'create').map((i) => i.id)).toEqual(['new']) // keyword
    expect(filterPalette(items, 'acme').map((i) => i.id)).toEqual(['chat-1']) // subtitle
    expect(filterPalette(items, 'approval').map((i) => i.id)).toEqual(['mode-plan']) // section
  })

  it('returns nothing when no item matches', () => {
    expect(filterPalette(items, 'zzzzz')).toHaveLength(0)
  })
})
