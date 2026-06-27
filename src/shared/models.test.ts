import { describe, expect, it } from 'vitest'
import type { ModelOption } from './types'
import { naturalCompare, sortedModels } from './models'

const ids = (ms: ModelOption[]): string[] => ms.map((m) => m.id)

describe('naturalCompare', () => {
  it('orders numeric segments by value, not lexically', () => {
    expect([{ id: 'v10' }, { id: 'v2' }].sort((a, b) => naturalCompare(a.id, b.id)).map((m) => m.id)).toEqual([
      'v2',
      'v10'
    ])
  })
})

describe('sortedModels', () => {
  it('restores the curated default order regardless of stored order', () => {
    // How an upgraded install looks: the migration appended GPT-5 to the bottom.
    const stored: ModelOption[] = [
      { id: 'gpt-4o' },
      { id: 'gpt-4o-mini' },
      { id: 'o3' },
      { id: 'o4-mini' },
      { id: 'gpt-5' },
      { id: 'gpt-5-mini' },
      { id: 'gpt-5-nano' }
    ]
    expect(ids(sortedModels('openai', stored))).toEqual([
      'gpt-5',
      'gpt-5-mini',
      'gpt-5-nano',
      'gpt-4o',
      'gpt-4o-mini',
      'o3',
      'o4-mini'
    ])
  })

  it('does not mutate the input array', () => {
    const stored: ModelOption[] = [{ id: 'o4-mini' }, { id: 'gpt-5' }]
    const before = ids(stored)
    sortedModels('openai', stored)
    expect(ids(stored)).toEqual(before)
  })

  it('places unrecognized (fetched/custom) models after the curated ones, in natural order', () => {
    const stored: ModelOption[] = [
      { id: 'zeta-model' },
      { id: 'gpt-5' },
      { id: 'alpha-model' },
      { id: 'gpt-4o' }
    ]
    expect(ids(sortedModels('openai', stored))).toEqual([
      'gpt-5', // curated, first
      'gpt-4o', // curated, after gpt-5
      'alpha-model', // unknown, natural order
      'zeta-model'
    ])
  })

  it('natural-sorts everything for a provider with no curated defaults (e.g. a local endpoint)', () => {
    const stored: ModelOption[] = [{ id: 'qwen2.5' }, { id: 'llama-3.1' }, { id: 'llama-3.10' }]
    expect(ids(sortedModels('ollama', stored))).toEqual(['llama-3.1', 'llama-3.10', 'qwen2.5'])
  })

  it('uses the label for ordering unknown models when present', () => {
    const stored: ModelOption[] = [
      { id: 'b', label: 'Apple' },
      { id: 'a', label: 'Banana' }
    ]
    expect(ids(sortedModels('custom', stored))).toEqual(['b', 'a'])
  })
})
