import { describe, it, expect, vi } from 'vitest'
import type { ProviderConfig } from '@shared/types'
import { modelDisplayName } from '@shared/models'
import { filterPalette, modelPaletteItems, type PaletteItem } from './palette'

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

describe('modelPaletteItems', () => {
  const provider = (over: Partial<ProviderConfig> & Pick<ProviderConfig, 'id' | 'kind'>): ProviderConfig =>
    ({ label: over.id, models: [], requiresKey: true, hasKey: true, ...over }) as ProviderConfig

  it('offers only providers that can be called now, under the picker\'s model names', () => {
    const rows = modelPaletteItems(
      [
        provider({ id: 'anthropic', kind: 'anthropic', label: 'Anthropic (Claude)', hasKey: false, models: [{ id: 'claude-opus-5-5' }] }),
        provider({ id: 'local', kind: 'openai-compatible', label: 'Ollama', requiresKey: false, hasKey: false, models: [{ id: 'qwen3' }] }),
        provider({ id: 'openai', kind: 'openai', label: 'OpenAI (GPT)', models: [{ id: 'gpt-6-astra', label: 'Astra' }] })
      ],
      { providerId: 'local', model: 'qwen3' },
      () => {}
    )
    // Anthropic has no key yet: picking its model would leave the composer disabled.
    expect(rows.map((r) => r.subtitle)).toEqual(['Ollama', 'OpenAI (GPT)'])
    expect(rows[0].title).toBe('Use qwen3')
    expect(rows[0].hint).toBe('✓ current')
    // An explicit label wins, as in the picker.
    expect(rows[1].title).toBe('Use Astra')
    expect(rows[1].hint).toBeUndefined()
    // The raw id stays searchable.
    expect(filterPalette(rows, 'gpt-6').map((r) => r.title)).toEqual(['Use Astra'])
  })

  it('names a Claude model the way the picker does and selects it', () => {
    const onSelect = vi.fn()
    const [row] = modelPaletteItems(
      [provider({ id: 'anthropic', kind: 'anthropic', models: [{ id: 'claude-opus-5-5' }] })],
      null,
      onSelect
    )
    expect(row.title).toBe(`Use ${modelDisplayName('anthropic', 'claude-opus-5-5')}`)
    expect(row.title).not.toContain('claude-opus-5-5')
    row.run()
    expect(onSelect).toHaveBeenCalledWith({ providerId: 'anthropic', model: 'claude-opus-5-5' })
  })
})
